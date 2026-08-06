# BLR Metro Live 🚇

A live map of Bengaluru's Namma Metro. BMRCL doesn't publish real-time train
positions, so this simulates them from the **official timetable**: terminal
departures come from a GTFS transcription of BMRCL's published schedules, and
each train is animated along the real track geometry with per-station dwells.

**Operational lines** (Aug 2026): Purple (Whitefield ↔ Challaghatta, 37
stations), Green (Madavara ↔ Silk Institute, 32), Yellow (RV Road ↔
Bommasandra, 16). **Shown as under construction**: Pink Line (18 stations,
phased opening from late 2026), Blue Line (Silk Board–KR Pura–Airport), Green
Line extension.

## Run it

Any static file server works (the app fetches JSON, so plain `file://` won't):

```bash
python -m http.server 8641
```

then open <http://localhost:8641>.

## Deploying (GitHub Pages)

The site is plain static files, so Pages needs no build step. Set
**Settings → Pages → Source = "GitHub Actions"** and let
`.github/workflows/deploy-pages.yml` publish it. That path is preferred over
"deploy from a branch" for two reasons: it skips Jekyll (nothing here needs
it, so no `.nojekyll` juggling), and its `workflow_run` trigger catches the
data-refresh commits — which are pushed with `GITHUB_TOKEN` and therefore do
*not* fire a normal `push` build. Without that, the live site would keep
serving yesterday's timetable and a frozen "last checked" time.

Also set **Settings → Actions → General → Workflow permissions** to
**Read and write**, or the data workflows can't commit their refreshed JSON.

## Features

- **Live IST clock** — trains running *right now*, including post-midnight
  runs; Monday early starts (04:15), Sunday late starts, and BMRCL's holiday
  calendar are respected.
- **Departure boards** — click any station (or search, or 📍 nearest-station)
  for next trains per direction with countdowns plus first/last times.
  Interchanges (Majestic, RV Road) show all lines.
- **📍 Near me** — geolocates you, marks your position, and opens the closest
  station's board with the distance.
- **Disruption handling** — see [Stale-data honesty](#stale-data-honesty)
  below. Two tiers (confirmed BMRCL advisory vs unconfirmed news report), with
  report age, a "may be resolved" state, and an always-visible last-checked
  time so an empty alert list never reads as a guarantee.
- **Future corridors, two tiers** — *under construction* (Pink, Blue, Green
  extension) as dashed 45%-opacity lines, and *announced / planned* (Orange,
  Red/Sarjapur–Hebbal, Hosahalli–Kadabagere) as faint 20%-opacity dotted
  lines. Each tier toggles separately; future stations show names on hover.
- **Line news** — tap any future corridor on the map, or its legend row, or
  the › on an operational line, for the latest headlines about that corridor
  (source + age, links out), plus a live news-search link.
- **Time travel** — scrub the day, play at 10×/60×/300×, jump back to LIVE.
- **Timetable view** — the exact service pattern in use, per line and day
  type, linked to official sources.

Design borrows the cream/ink poster look of [bengaluru.fyi](https://bengaluru.fyi)
(Anton + Archivo, hard offset shadows, `#f4eee2` / `#14110e` / `#ffcb05`).

## Data pipeline

| File | Role |
| --- | --- |
| `data/network.json` | Track geometry + stations (chainage in metres), plus future corridors tagged `stage: construction \| planned` — from OpenStreetMap |
| `data/news.json` | Latest headlines per line, baked at build time (Google News RSS sends no CORS headers, so a static page can't fetch it live) |
| `data/schedule.json` | Exact terminal departures per line/direction/service day + holiday dates — from the [Vonter/bmrcl-gtfs](https://github.com/Vonter/bmrcl-gtfs) feed (a transcription of official BMRCL timetables) |
| `data/advisories.json` | Hand-vetted service advisories shown to riders (see `_howto` inside) |
| `js/service.js` | Fallback headway bands, end-to-end runtimes, dwell time — used only if `schedule.json` is missing |
| `js/sim.js` | `LineSim` — resolves any wall-clock instant to train positions and station departure boards |
| `js/app.js` | Leaflet map, markers, boards, search, geolocation, controls |
| `tools/fetch_osm.mjs` | Regenerates `network.json` (`node tools/fetch_osm.mjs`, or `--future-only` to refresh just the construction corridors) |
| `tools/fetch_gtfs.py` | Regenerates `schedule.json` (`python tools/fetch_gtfs.py`) |
| `tools/fetch_line_news.mjs` | Regenerates `news.json` (`node tools/fetch_line_news.mjs`) — per-line news, relevance-filtered so generic BMRCL stories aren't attributed to a specific corridor |
| `tools/fetch_news.mjs` | Scans Google News RSS for *disruption* headlines and prints advisory candidates — always verify via [@OfficialBMRCL](https://x.com/OfficialBMRCL) before publishing |

`.github/workflows/refresh-data.yml` re-runs the timetable, corridor, and news
fetchers daily and commits any changes, so a GitHub Pages deploy stays current
without manual work. Advisories stay manual by design.

Intermediate-station times are interpolated from distance at a per-line
calibrated speed (GTFS's own intermediate times are estimates too). Short-loop
trips (~15% of the feed, e.g. Whitefield–Mysuru Road turnbacks) aren't
modelled yet — the map shows full end-to-end runs only.

## Stale-data honesty

The hard case: a disruption starts at 09:30 and a rider opens the map at 11:00.
A schedule-driven map will happily say "next train 3 min" as though nothing
happened. What the app does about it:

| Situation at view time | What the rider sees |
| --- | --- |
| Confirmed advisory, still open | Red banner: *"Green Line services delayed — Reported 09:30 · 1 h 30 min ago"*, ⚠ on the line row, trains **faded**, and every affected departure board warns that times are *scheduled*. |
| Confirmed advisory that ended 30 min ago | Same banner plus *"May be resolved — status unconfirmed"* (kept for 3 h, then dropped). |
| Only a news report, unconfirmed | Dashed, quieter card tagged **Unconfirmed report** with source and age. Boards warn, but trains are *not* faded — an unverified signal shouldn't overrule the schedule. |
| Nothing known, last scan 4 min ago | *"✓ No disruptions reported · checked 10:56"* — a **bounded** all-clear. |
| Nothing known, last scan 5 h ago | Yellow warning: *"Disruption check last ran 06:00 (5 h ago) — a newer disruption would not show here."* |

Mechanics: `scan-disruptions.yml` runs every 15 minutes and always commits the
scan timestamp (even on a clean scan — a fresh "nothing found" is the useful
part). The page re-polls every 3 minutes, and also on `visibilitychange`,
`focus`, and bfcache `pageshow`, so a tab left open since morning can't keep
showing a frozen all-clear. Alert ages re-render every minute.

Known limits, deliberately visible rather than hidden: GitHub's scheduled runs
are best-effort and can lag 10+ minutes (hence always showing the scan time);
news lags the incident itself, so @OfficialBMRCL is linked from every warning;
and post-disruption bunching isn't modelled at all, which is why affected
boards say *scheduled* rather than predicted.

## Being honest with riders

Positions are **schedule fiction**, not telemetry. The app mitigates this by:
using the official timetable transcription rather than guessed headways;
showing a "not live telemetry" disclaimer; and surfacing vetted advisories
with pointers to [@OfficialBMRCL](https://x.com/OfficialBMRCL) and the
helpline (1800-425-12345) whenever the schedule may not hold. If BMRCL's
announced open-data portal ships GTFS-Realtime, `js/sim.js` is the seam where
live trip updates would replace the schedule.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors (ODbL), rendered on CARTO tiles. Timetable via
[Vonter/bmrcl-gtfs](https://github.com/Vonter/bmrcl-gtfs).
