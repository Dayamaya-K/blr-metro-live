"""Convert the Vonter/bmrcl-gtfs feed into data/schedule.json.

The feed transcribes BMRCL's officially published timetables into GTFS.
We extract, per line / service day / direction, the list of terminal
departure times (seconds since midnight IST), which the simulator then
uses instead of the approximate headway bands.

Usage: python tools/fetch_gtfs.py [path-to-bmrcl.zip]
       (downloads the zip from GitHub when no path is given)
"""

import csv
import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

URL = "https://github.com/Vonter/bmrcl-gtfs/raw/main/gtfs/bmrcl.zip"
ROOT = Path(__file__).resolve().parent.parent


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def hms_to_sec(hms: str) -> int:
    h, m, s = map(int, hms.split(":"))
    return h * 3600 + m * 60 + s


def main() -> None:
    if len(sys.argv) > 1:
        raw = Path(sys.argv[1]).read_bytes()
        print(f"Using local {sys.argv[1]}")
    else:
        print(f"Downloading {URL} ...")
        req = urllib.request.Request(URL, headers={"User-Agent": "blr-metro-live/1.0"})
        raw = urllib.request.urlopen(req).read()
    z = zipfile.ZipFile(io.BytesIO(raw))

    def rows(name):
        return list(csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8-sig")))

    # our geometry's terminal names decide which GTFS direction is dir 0/1
    net = json.loads((ROOT / "data" / "network.json").read_text(encoding="utf-8"))
    terminals = {
        l["id"]: (norm(l["stations"][0]["name"]), norm(l["stations"][-1]["name"]))
        for l in net["lines"]
    }

    routes = {r["route_id"]: r["route_short_name"].lower() for r in rows("routes.txt")}
    trips = rows("trips.txt")
    feed_info = rows("feed_info.txt")[0] if "feed_info.txt" in z.namelist() else {}

    # first-stop departure time per trip
    first_dep = {}
    for st in csv.DictReader(io.TextIOWrapper(z.open("stop_times.txt"), "utf-8-sig")):
        if st["stop_sequence"] == "1":
            first_dep[st["trip_id"]] = hms_to_sec(st["departure_time"])

    # holiday calendar (exception_type 1 = holiday service applies that date)
    holidays = sorted(
        cd["date"]
        for cd in rows("calendar_dates.txt")
        if cd["service_id"] == "holiday" and cd["exception_type"] == "1"
    ) if "calendar_dates.txt" in z.namelist() else []

    lines: dict = {}
    skipped_short_loop = 0
    for t in trips:
        line = routes.get(t["route_id"])
        if line not in terminals or t["trip_id"] not in first_dep:
            continue
        head = norm(t["trip_headsign"])
        start_name, end_name = terminals[line]
        if head == end_name:
            di = 0  # towards our stations[-1]
        elif head == start_name:
            di = 1
        else:
            skipped_short_loop += 1  # short-loop / depot trip we don't model
            continue
        day = t["service_id"]
        lines.setdefault(line, {}).setdefault(day, [[], []])[di].append(
            first_dep[t["trip_id"]]
        )

    for line, days in lines.items():
        for day, dirs in days.items():
            for deps in dirs:
                deps.sort()

    out = {
        "source": "Vonter/bmrcl-gtfs (transcribed from official BMRCL timetables)",
        "url": "https://github.com/Vonter/bmrcl-gtfs",
        "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "feedVersion": feed_info.get("feed_version", ""),
        "holidays": holidays,
        "lines": lines,
    }
    (ROOT / "data" / "schedule.json").write_text(json.dumps(out), encoding="utf-8")

    for line, days in sorted(lines.items()):
        for day, (d0, d1) in sorted(days.items()):
            fmt = lambda s: f"{s // 3600:02d}:{s % 3600 // 60:02d}"
            print(
                f"{line:7s} {day:8s} dir0 {len(d0):3d} trips {fmt(d0[0])}-{fmt(d0[-1])}"
                f" | dir1 {len(d1):3d} trips {fmt(d1[0])}-{fmt(d1[-1])}"
            )
    print(f"skipped (short-loop/unmatched): {skipped_short_loop}")
    print(f"holidays listed: {len(holidays)}")
    print("Wrote data/schedule.json")


if __name__ == "__main__":
    main()
