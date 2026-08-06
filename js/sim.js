"use strict";
// Schedule-driven train position simulator.
// A LineSim turns line geometry + a timetable into train positions for any
// moment in time. Departures come from the GTFS-derived exact timetable
// (data/schedule.json) when available, else from the headway bands in
// service.js. Each run follows a piecewise run/dwell profile along the track.

const SEC_DAY = 86400;

function parseHM(s) {
  const [h, m] = s.split(":").map(Number);
  return h * 3600 + m * 60;
}

function fmtDep(s) {
  s = ((s % SEC_DAY) + SEC_DAY) % SEC_DAY;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// GTFS service classes: monday / weekday (Tue-Sat) / sunday / holiday
function schedDayKey(desc, holidays) {
  if (holidays.includes(desc.ymd)) return "holiday";
  if (desc.idx === 1) return "monday";
  if (desc.idx === 0) return "sunday";
  return "weekday";
}

// headway-band fallback classes: weekday (Mon-Fri) / saturday / sunday
function bandsDayKey(desc) {
  return desc.idx === 0 ? "sunday" : desc.idx === 6 ? "saturday" : "weekday";
}

class LineSim {
  // sched: schedule.json lines[id] — { dayKey: [[dir0 deps], [dir1 deps]] }
  constructor(line, cfg, sched, holidays) {
    this.line = line;
    this.cfg = cfg;
    this.sched = sched ?? null;
    this.holidays = holidays ?? [];
    this.bandsCache = new Map();

    // cumulative distance along the shape
    this.cum = [0];
    for (let i = 1; i < line.shape.length; i++) {
      const [aLat, aLon] = line.shape[i - 1];
      const [bLat, bLon] = line.shape[i];
      this.cum.push(this.cum[i - 1] + haversineM(aLat, aLon, bLat, bLon));
    }

    const sts = line.stations;
    const n = sts.length;
    const runDist = Math.abs(sts[n - 1].d - sts[0].d);
    const runTime = cfg.endToEndMin * 60 - (n - 2) * cfg.dwellSec;
    this.speed = runDist / runTime; // m/s while moving

    this.dirs = [
      this.profile(sts, +1),
      this.profile([...sts].reverse(), -1),
    ];
    this.total = this.dirs[0].total;
  }

  // arrival/departure time offsets (sec from terminal departure) per station
  profile(sts, sign) {
    const n = sts.length;
    const arr = [0];
    const dep = [0];
    for (let i = 1; i < n; i++) {
      const dist = Math.abs(sts[i].d - sts[i - 1].d);
      arr[i] = dep[i - 1] + dist / this.speed;
      dep[i] = arr[i] + (i < n - 1 ? this.cfg.dwellSec : 0);
    }
    return { sts, arr, dep, sign, total: arr[n - 1], towards: sts[n - 1].name };
  }

  // elapsed sec since terminal departure -> position along the run
  posAt(p, e) {
    const { sts, arr, dep } = p;
    const n = sts.length;
    if (e < 0 || e > p.total) return null;
    let i = 0;
    while (i < n - 2 && arr[i + 1] <= e) i++;
    if (arr[i + 1] <= e) return null; // arrived at terminus
    if (e < dep[i]) {
      return { chain: sts[i].d, nextIdx: i + 1, dwelling: true, eta: arr[i + 1] - e };
    }
    const f = (e - dep[i]) / (arr[i + 1] - dep[i]);
    const chain = sts[i].d + (sts[i + 1].d - sts[i].d) * f;
    return { chain, nextIdx: i + 1, dwelling: false, eta: arr[i + 1] - e };
  }

  latLonAt(chain) {
    const cum = this.cum;
    const shape = this.line.shape;
    if (chain <= 0) return shape[0];
    if (chain >= cum[cum.length - 1]) return shape[shape.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= chain) lo = mid;
      else hi = mid;
    }
    const f = (chain - cum[lo]) / (cum[hi] - cum[lo] || 1e-9);
    return [
      shape[lo][0] + (shape[hi][0] - shape[lo][0]) * f,
      shape[lo][1] + (shape[hi][1] - shape[lo][1]) * f,
    ];
  }

  bearingAt(chain, sign) {
    const a = this.latLonAt(chain);
    const b = this.latLonAt(chain + sign * 25);
    const dx = (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180);
    const dy = b[0] - a[0];
    if (dx === 0 && dy === 0) return 0;
    return (Math.atan2(dx, dy) * 180) / Math.PI;
  }

  bandsDeps(dayKey) {
    if (this.bandsCache.has(dayKey)) return this.bandsCache.get(dayKey);
    const bands = this.cfg.days[dayKey] ?? [];
    const deps = [];
    for (const [from, to, headway] of bands) {
      const end = parseHM(to);
      for (let s = parseHM(from); s < end; s += headway * 60) deps.push(s);
    }
    deps.sort((a, b) => a - b);
    this.bandsCache.set(dayKey, deps);
    return deps;
  }

  // terminal departures for a given day (desc: {idx, ymd}) and direction
  depsFor(desc, di) {
    if (this.sched) {
      const key = schedDayKey(desc, this.holidays);
      const day =
        this.sched[key] ?? this.sched[key === "holiday" ? "sunday" : "weekday"];
      if (day) return day[di] ?? [];
    }
    return this.bandsDeps(bandsDayKey(desc)); // same pattern both directions
  }

  // all live trains at a given IST moment (info: {sec, idx, ymd, yest, tom})
  trainsAt(info) {
    const out = [];
    const windows = [
      [info, 0],
      [info.yest, SEC_DAY], // late runs that started before midnight
    ];
    for (const [desc, off] of windows) {
      for (let di = 0; di < 2; di++) {
        const p = this.dirs[di];
        for (const dep of this.depsFor(desc, di)) {
          const e = info.sec + off - dep;
          if (e < 0 || e > this.total) continue;
          const pos = this.posAt(p, e);
          if (!pos) continue;
          const [lat, lon] = this.latLonAt(pos.chain);
          out.push({
            key: `${this.line.id}:${di}:${dep}`,
            lineId: this.line.id,
            color: this.line.color,
            lat,
            lon,
            bearing: this.bearingAt(pos.chain, p.sign),
            towards: p.towards,
            next: p.sts[pos.nextIdx].name,
            eta: pos.eta,
            dwelling: pos.dwelling,
            at: pos.dwelling ? p.sts[pos.nextIdx - 1].name : null,
          });
        }
      }
    }
    return out;
  }

  // rider departure board: upcoming boardable trains from a station (matched
  // by chainage), for each direction. Terminus directions are skipped.
  boardsFor(stationD, info, count = 3) {
    const out = [];
    for (let di = 0; di < 2; di++) {
      const p = this.dirs[di];
      const idx = p.sts.findIndex((s) => s.d === stationD);
      if (idx < 0 || idx >= p.sts.length - 1) continue;
      const stOff = p.dep[idx]; // departure offset from terminal start
      const upcoming = [];
      for (const [desc, shift] of [[info, 0], [info.yest, -SEC_DAY]]) {
        for (const dep of this.depsFor(desc, di)) {
          const t = dep + stOff + shift;
          if (t >= info.sec) upcoming.push(t);
        }
      }
      upcoming.sort((a, b) => a - b);
      const today = this.depsFor(info, di);
      const tom = this.depsFor(info.tom, di);
      out.push({
        towards: p.towards,
        upcoming: upcoming.slice(0, count),
        first: today.length ? today[0] + stOff : null,
        last: today.length ? today[today.length - 1] + stOff : null,
        tomorrowFirst: tom.length ? tom[0] + stOff : null,
      });
    }
    return out;
  }

  // human string for the current service frequency
  headwayNow(info) {
    const deps = this.depsFor(info, 0);
    if (!deps.length) return "no service today";
    if (info.sec < deps[0]) return `starts ${fmtDep(deps[0])}`;
    const i = deps.findIndex((d) => d > info.sec);
    if (i === -1) return "service ended";
    return `every ~${Math.max(1, Math.round((deps[i] - deps[i - 1]) / 60))} min`;
  }
}
