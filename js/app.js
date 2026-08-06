"use strict";
// Map + UI. Requires Leaflet, SERVICE (service.js), LineSim (sim.js).

const SLOW_MS = 250;     // cadence for panel text (clock, counts, slider)
const POPUP_MS = 400;    // cadence for an open train popup's content
const LABEL_ZOOM = 14;

// official-ish line colours tuned for contrast on the cream basemap
const LINE_COLORS = { purple: "#7d3f8d", green: "#00913b", yellow: "#eab500" };

const state = {
  live: true,
  playing: true,
  speed: 60,
  simMs: Date.now(),
  lastTick: performance.now(),
  scrubbing: false,
  lastSlow: 0,
  showLabels: localStorage.getItem("blrml.labels") !== "0",
  sims: [],
  enabled: {},
  markers: new Map(),  // train key -> { marker, wrap, train }
  groups: {},          // lineId -> L.layerGroup for trains
  allStations: [],     // { lineId, color, lineName, s }
  stationMarkers: [],  // { marker, name, labeled }
  selected: null,      // { name, entry, members: [{lineId, d}] }
  lastBoardSec: -1,
  sched: null,         // data/schedule.json (GTFS-derived), if present
  news: null,          // data/news.json — headlines per line
  futureMeta: {},      // future line id -> { label, color, stage, termini }
  advisories: [],
  signalsMeta: null,
  alertsCheckedAt: 0,
  disruptedLines: new Set(),
  confirmedDisrupted: new Set(),
  userPos: null,
  userMarker: null,
};

const IST_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hourCycle: "h23",
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const YMD_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const DAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function istInfo(ms) {
  const parts = {};
  for (const p of IST_FMT.formatToParts(ms)) parts[p.type] = p.value;
  const sec = +parts.hour * 3600 + +parts.minute * 60 + +parts.second;
  return {
    sec,
    idx: DAY_IDX[parts.weekday],
    ymd: YMD_FMT.format(ms).replace(/-/g, ""),
    clock: `${parts.hour}:${parts.minute}:${parts.second}`,
    dateLabel: `${parts.weekday} ${parts.day} ${parts.month}`,
  };
}
// info + adjacent-day descriptors (for post-midnight runs & tomorrow's first)
function fullInfo(ms) {
  const info = istInfo(ms);
  info.yest = istInfo(ms - 86400000);
  info.tom = istInfo(ms + 86400000);
  return info;
}

const fmtEta = (s) =>
  s < 60 ? `${Math.max(0, Math.round(s))}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
const fmtHM = (s) => {
  s = ((s % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function distM(aLat, aLon, bLat, bLon) {
  const dx = (aLon - bLon) * 102000, dy = (aLat - bLat) * 110500;
  return Math.sqrt(dx * dx + dy * dy);
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

// ---------- map ----------

const map = L.map("map", { zoomControl: false }).setView([12.9629, 77.5875], 12);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  maxZoom: 19,
}).addTo(map);

// top-down train glyph, nose pointing up; rotated to the heading
function trainIcon(color) {
  const svg =
    `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M12 2C8.2 2 6.5 4 6.5 7v11a3.4 3.4 0 0 0 3.4 3.4h4.2A3.4 3.4 0 0 0 17.5 18V7c0-3-1.7-5-5.5-5Z" fill="${color}" stroke="#14110e" stroke-width="1.6"/>` +
    `<rect x="8.4" y="4.6" width="7.2" height="2.8" rx="1.4" fill="#fff" opacity="0.95"/>` +
    `<rect x="8.4" y="10.4" width="7.2" height="1.7" rx="0.85" fill="#fff" opacity="0.85"/>` +
    `<rect x="8.4" y="13.6" width="7.2" height="1.7" rx="0.85" fill="#fff" opacity="0.85"/>` +
    `</svg>`;
  return L.divIcon({
    className: "train-icon",
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<div class="train-wrap">${svg}</div>`,
  });
}

function popupHtml(t) {
  const where = t.dwelling
    ? `At <b>${esc(t.at)}</b>`
    : `Next: <b>${esc(t.next)}</b> in ${fmtEta(t.eta)}`;
  const alerted = state.disruptedLines.has(t.lineId);
  return (
    `<div class="pp">` +
    `<span class="pp-line" style="background:${t.color}"></span>` +
    `<b>${cap(t.lineId)} Line</b><br>` +
    `towards ${esc(t.towards)}<br>${where}` +
    (alerted
      ? `<div class="pp-warn">⚠ Disruption reported — this is the <b>scheduled</b> position, not a live one.</div>`
      : "") +
    `</div>`
  );
}

function upsertTrain(t, now) {
  let rec = state.markers.get(t.key);
  if (!rec) {
    const marker = L.marker([t.lat, t.lon], {
      icon: trainIcon(t.color),
      keyboard: false,
    });
    marker.bindPopup(popupHtml(t), { closeButton: false, offset: [0, -8] });
    marker.addTo(state.groups[t.lineId]);
    rec = { marker, wrap: null, train: t, popupAt: 0 };
    state.markers.set(t.key, rec);
  } else {
    rec.marker.setLatLng([t.lat, t.lon]);
    rec.train = t;
  }
  if (!rec.wrap) {
    const el = rec.marker.getElement();
    if (el) rec.wrap = el.querySelector(".train-wrap");
  }
  if (rec.wrap) rec.wrap.style.transform = `rotate(${t.bearing.toFixed(1)}deg)`;
  // trains on a confirmed-disrupted line are faded: the schedule can't be trusted
  const dim = state.confirmedDisrupted.has(t.lineId);
  if (rec.dim !== dim) {
    rec.marker.setOpacity(dim ? 0.4 : 1);
    rec.dim = dim;
  }
  // content refresh only matters while the popup is open, and not per-frame
  if (rec.marker.isPopupOpen() && now - rec.popupAt >= POPUP_MS) {
    rec.popupAt = now;
    rec.marker.setPopupContent(popupHtml(t));
  }
}

// ---------- station departure card ----------

// stations of any line within 200 m of this one (interchange grouping)
function stationGroup(entry) {
  const members = [{ lineId: entry.lineId, d: entry.s.d }];
  for (const other of state.allStations) {
    if (other === entry || other.lineId === entry.lineId) continue;
    if (distM(entry.s.lat, entry.s.lon, other.s.lat, other.s.lon) < 200)
      members.push({ lineId: other.lineId, d: other.s.d });
  }
  return members;
}

function openStation(entry, fly) {
  state.selected = { name: entry.s.name, entry, members: stationGroup(entry) };
  document.getElementById("card-name").textContent = entry.s.name;
  const distEl = document.getElementById("card-dist");
  distEl.textContent = state.userPos
    ? `~${fmtDist(distM(state.userPos.lat, state.userPos.lon, entry.s.lat, entry.s.lon))} from your location`
    : "";
  document.getElementById("station-card").hidden = false;
  state.lastBoardSec = -1; // force re-render on next tick
  if (isMobile()) { closeLineCard(); setPanelCollapsed(true); } // make room for the board
  if (fly) map.setView([entry.s.lat, entry.s.lon], Math.max(map.getZoom(), 14));
  renderBoards(fullInfo(state.simMs));
}

function closeStation() {
  state.selected = null;
  document.getElementById("station-card").hidden = true;
}

function renderBoards(info) {
  if (!state.selected) return;
  const holder = document.getElementById("card-boards");
  let html = "";
  for (const m of state.selected.members) {
    const sim = state.sims.find((s) => s.line.id === m.lineId);
    if (!sim || !state.enabled[m.lineId]) continue;
    html += `<div class="board-line"><div class="board-head">` +
      `<span class="dot" style="background:${sim.line.color}"></span>${sim.line.name}</div>`;
    // an alert with no `lines` is network-wide
    const adv = state.advisories.find(
      (it) => !it.lines?.length || it.lines.includes(m.lineId)
    );
    if (adv)
      html +=
        `<div class="board-warn${adv.confidence === "unverified" ? " soft" : ""}">` +
        `⚠ ${adv.confidence === "unverified" ? "Unconfirmed report" : "Disruption reported"}` +
        (adv.at ? ` at ${fmtClockOf(adv.at)} (${fmtAgo(adv.at)})` : "") +
        `${adv.state === "recent" ? ", may be resolved" : ""}. ` +
        `The times below are <b>scheduled</b> and may not hold. ` +
        `<a href="https://x.com/OfficialBMRCL" target="_blank" rel="noopener">Check @OfficialBMRCL</a></div>`;
    for (const b of sim.boardsFor(m.d, info)) {
      let times;
      if (b.upcoming.length) {
        times = b.upcoming
          .map((t) => {
            const mins = Math.round((t - info.sec) / 60);
            return mins < 1 ? `<span class="now">now</span>` : `${mins} min`;
          })
          .join(" · ");
      } else if (b.first !== null && info.sec < b.first) {
        times = `first train ${fmtHM(b.first)}`;
      } else {
        times = `ended — tomorrow ${b.tomorrowFirst !== null ? fmtHM(b.tomorrowFirst) : "–"}`;
      }
      html += `<div class="board-dir">` +
        `<div class="dir-name">→ ${esc(b.towards)}</div>` +
        `<div class="times">${times}</div>` +
        (b.first !== null
          ? `<div class="firstlast">first ${fmtHM(b.first)} · last ${fmtHM(b.last)}</div>`
          : "") +
        `</div>`;
    }
    html += `</div>`;
  }
  holder.innerHTML = html || `<div class="firstlast">No service on this station's lines.</div>`;
}

// ---------- station labels: hover tips zoomed out, printed labels zoomed in ----------

function refreshLabels() {
  const show = state.showLabels && map.getZoom() >= LABEL_ZOOM;
  for (const rec of state.stationMarkers) {
    if (rec.labeled === show) continue;
    rec.marker.unbindTooltip();
    rec.marker.bindTooltip(
      rec.name,
      show
        ? { permanent: true, direction: "right", offset: [7, 0], className: "stn-label" }
        : { direction: "top", className: "stn-tip" }
    );
    rec.labeled = show;
  }
}
map.on("zoomend", refreshLabels);

function wireLabelsToggle() {
  const box = document.getElementById("labels-toggle");
  box.checked = state.showLabels;
  box.addEventListener("change", () => {
    state.showLabels = box.checked;
    localStorage.setItem("blrml.labels", box.checked ? "1" : "0");
    refreshLabels();
  });
}

// ---------- boot ----------

async function boot() {
  const net = await (await fetch("data/network.json", { cache: "no-cache" })).json();
  try {
    state.sched = await (await fetch("data/schedule.json", { cache: "no-cache" })).json();
  } catch {
    state.sched = null;
  }
  try {
    state.news = await (await fetch("data/news.json", { cache: "no-cache" })).json();
  } catch {
    state.news = null;
  }

  for (const line of net.lines) {
    line.color = LINE_COLORS[line.id] ?? line.color;
    for (const s of line.stations)
      s.name = s.name.replace(/\s*\((?:Purple|Green|Yellow|Pink|Blue) Line\)$/i, "");
  }

  state.allStations = [];
  for (const line of net.lines)
    for (const s of line.stations)
      state.allStations.push({ lineId: line.id, lineName: line.name, color: line.color, s });

  // interchange = stations of different lines within 200 m
  const interchange = new Set();
  for (const e of state.allStations)
    if (stationGroup(e).length > 1) interchange.add(e);

  const linesEl = document.getElementById("lines");
  for (const line of net.lines) {
    const cfg = SERVICE.lines[line.id];
    if (!cfg) continue;
    state.sims.push(
      new LineSim(line, cfg, state.sched?.lines?.[line.id] ?? null, state.sched?.holidays ?? [])
    );
    state.enabled[line.id] = true;

    // track: white casing + crisp coloured line
    const casing = L.polyline(line.shape, { color: "#ffffff", weight: 8, opacity: 0.85, interactive: false });
    const track = L.polyline(line.shape, { color: line.color, weight: 4, opacity: 0.95, interactive: false });

    const stations = L.layerGroup();
    for (const entry of state.allStations) {
      if (entry.lineId !== line.id) continue;
      const s = entry.s;
      const inter = interchange.has(entry);
      const marker = L.circleMarker([s.lat, s.lon], {
        radius: inter ? 6 : 4.5,
        color: "#14110e",
        weight: 1.5,
        fillColor: inter ? "#ffffff" : line.color,
        fillOpacity: 1,
      });
      marker.bindTooltip(s.name, { direction: "top", className: "stn-tip" });
      marker.on("click", () => openStation(entry, false));
      marker.addTo(stations);
      state.stationMarkers.push({ marker, name: s.name, labeled: false });
    }

    const trains = L.layerGroup();
    state.groups[line.id] = trains;
    const lineGroup = L.layerGroup([casing, track, stations, trains]).addTo(map);

    // panel row
    const row = document.createElement("label");
    row.className = "line-row";
    row.innerHTML =
      `<input type="checkbox" checked>` +
      `<span class="dot" style="background:${line.color}"></span>` +
      `<span class="line-name">${line.name}</span>` +
      `<span class="adv-badge" id="adv-${line.id}" hidden title="service advisory">⚠</span>` +
      `<span class="hw" id="hw-${line.id}"></span>` +
      `<span class="count" id="count-${line.id}">0</span>` +
      `<button class="news-btn" title="Latest news on this line">›</button>`;
    // inside a <label>, so suppress the implicit checkbox toggle
    row.querySelector(".news-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLineCard(line.id);
    });
    row.querySelector("input").addEventListener("change", (e) => {
      state.enabled[line.id] = e.target.checked;
      if (e.target.checked) lineGroup.addTo(map);
      else lineGroup.remove();
      state.lastBoardSec = -1;
    });
    linesEl.appendChild(row);
  }

  buildFutureLines(net.future ?? []);
  wirePanelToggle();
  wireLabelsToggle();
  wireControls();
  wireSearch();
  wireTimetable();
  wireGeo();
  document.getElementById("card-close").addEventListener("click", closeStation);
  document.getElementById("line-card-close").addEventListener("click", closeLineCard);
  loadAlerts();
  setInterval(loadAlerts, 3 * 60 * 1000);
  // A tab left open since morning must not keep showing a stale all-clear.
  // Background timers get throttled (and a bfcache restore freezes them
  // entirely), so re-check on every path back to the page.
  const recheckIfStale = () => {
    if (!document.hidden && Date.now() - (state.alertsCheckedAt ?? 0) > 60000) loadAlerts();
  };
  document.addEventListener("visibilitychange", recheckIfStale);
  window.addEventListener("focus", recheckIfStale);
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) loadAlerts(); // restored from back/forward cache
  });
  setInterval(renderAlerts, 60 * 1000); // keep the "X min ago" wording current
  state.lastTick = performance.now();
  requestAnimationFrame(frame);
}

// ---------- panel collapse (phones start collapsed so the map is visible) ----------

const isMobile = () => matchMedia("(max-width: 560px)").matches;

function setPanelCollapsed(c) {
  document.getElementById("panel").classList.toggle("collapsed", c);
  document.getElementById("panel-toggle").textContent = c ? "▸" : "▾";
}

function wirePanelToggle() {
  document.getElementById("panel-toggle").addEventListener("click", () =>
    setPanelCollapsed(!document.getElementById("panel").classList.contains("collapsed"))
  );
  if (isMobile()) setPanelCollapsed(true);
}

// ---------- future / under-construction lines ----------

const FUTURE_NOTES = {
  pink: "Kalena Agrahara – Nagawara · phased opening from late 2026",
  blue: "Central Silk Board – KR Pura – Airport",
  "green-ext": "Phase 2 extension",
  orange: "Phase 3 · approved, not yet started",
  red: "Phase 3A · awaiting central approval",
  kadabagere: "Phase 3 addition",
  future: "future corridor",
};
const STAGE_LABEL = { construction: "Under construction", planned: "Announced / planned" };

// per-tier line styling: construction reads solid-ish dashed, planned is faint dotted
const STAGE_STYLE = {
  construction: { weight: 3, opacity: 0.45, dashArray: "6 7" },
  planned: { weight: 2.5, opacity: 0.2, dashArray: "1 6" },
};

function buildFutureLines(future) {
  if (!future || !future.corridors?.length) return;
  state.futureMeta = Object.fromEntries(future.lines.map((l) => [l.id, l]));
  const meta = state.futureMeta;

  const groups = { construction: L.layerGroup(), planned: L.layerGroup() };
  for (const c of future.corridors) {
    const stage = c.stage ?? "construction";
    const g = groups[stage] ?? groups.construction;
    const color = meta[c.id]?.color ?? "#8a8175";
    L.polyline(c.shape, { color, interactive: false, ...STAGE_STYLE[stage] }).addTo(g);
    // invisible fat line so thin/faint corridors are still tappable
    L.polyline(c.shape, { color, weight: 14, opacity: 0 })
      .on("click", () => openLineCard(c.id))
      .addTo(g);
  }
  for (const s of future.stations ?? []) {
    const stage = s.stage ?? "construction";
    const g = groups[stage] ?? groups.construction;
    L.circleMarker([s.lat, s.lon], {
      radius: stage === "planned" ? 3 : 3.5,
      color: "#8a8175",
      weight: 1.5,
      fillColor: "#ffffff",
      fillOpacity: stage === "planned" ? 0.55 : 0.9,
      opacity: stage === "planned" ? 0.5 : 0.9,
    })
      .bindTooltip(
        `${s.name} — ${meta[s.lineId]?.label ?? "future"}, ${
          stage === "planned" ? "planned" : "under construction"
        }`,
        { direction: "top", className: "stn-tip" }
      )
      .on("click", () => openLineCard(s.lineId))
      .addTo(g);
  }
  for (const g of Object.values(groups)) g.addTo(map);

  // legend, grouped by tier
  const el = document.getElementById("future");
  let html = "";
  for (const stage of ["construction", "planned"]) {
    const lines = future.lines.filter((l) => (l.stage ?? "construction") === stage);
    if (!lines.length) continue;
    html +=
      `<label class="line-row future-toggle" data-stage="${stage}">` +
      `<input type="checkbox" checked>` +
      `<span class="kick" style="color:inherit">${STAGE_LABEL[stage]}</span></label>` +
      lines
        .map(
          (f) =>
            `<div class="future-row ${stage}" data-line="${esc(f.id)}" role="button" tabindex="0">` +
            `<span class="dash" style="border-color:${f.color}"></span>` +
            `<span><b>${esc(f.label)}</b><br><span class="future-note">${esc(
              f.termini || FUTURE_NOTES[f.id] || FUTURE_NOTES.future
            )}</span></span><span class="news-chev">›</span></div>`
        )
        .join("");
  }
  el.innerHTML = html;

  for (const toggle of el.querySelectorAll(".future-toggle input")) {
    const stage = toggle.closest(".future-toggle").dataset.stage;
    toggle.addEventListener("change", (e) => {
      if (e.target.checked) groups[stage].addTo(map);
      else groups[stage].remove();
    });
  }
  for (const row of el.querySelectorAll(".future-row")) {
    const open = () => openLineCard(row.dataset.line);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
    });
  }
}

// ---------- line news card ----------

const NEWS_SEARCH = {
  pink: '"Pink Line" Namma Metro',
  blue: '"Blue Line" Bengaluru metro airport',
  "green-ext": "Namma Metro Green Line extension",
  orange: '"Orange Line" Bengaluru metro',
  red: "Sarjapur Hebbal metro Bengaluru",
  kadabagere: "Hosahalli Kadabagere metro",
  purple: '"Purple Line" Namma Metro',
  green: '"Green Line" Namma Metro',
  yellow: '"Yellow Line" Namma Metro',
};

function relDays(iso) {
  const d = Math.round((Date.now() - Date.parse(iso)) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  const m = Math.round(d / 30);
  return m <= 1 ? "1 month ago" : `${m} months ago`;
}

function openLineCard(lineId) {
  const meta = state.futureMeta?.[lineId];
  const sim = state.sims.find((s) => s.line.id === lineId);
  const label = meta?.label ?? sim?.line.name ?? lineId;
  const color = meta?.color ?? sim?.line.color ?? "#8a8175";
  const stage = meta?.stage ?? (sim ? "operational" : "construction");

  document.getElementById("line-card").hidden = false;
  document.getElementById("line-card-name").textContent = label;
  document.getElementById("line-card-stage").innerHTML =
    `<span class="pp-line" style="background:${color}"></span>` +
    `${stage === "operational" ? "In service" : STAGE_LABEL[stage]}` +
    (meta?.termini ? ` · ${esc(meta.termini)}` : "") +
    (meta && FUTURE_NOTES[lineId] && !meta.termini ? "" : "");

  const holder = document.getElementById("line-card-news");
  const items = state.news?.lines?.[lineId] ?? [];
  const searchUrl =
    "https://news.google.com/search?q=" +
    encodeURIComponent(NEWS_SEARCH[lineId] ?? `${label} Bengaluru metro`);

  if (!state.news) {
    holder.innerHTML = `<div class="firstlast">News feed not loaded.</div>`;
  } else if (!items.length) {
    holder.innerHTML =
      `<div class="firstlast">No recent headlines found for this corridor.</div>`;
  } else {
    holder.innerHTML = items
      .map(
        (n) =>
          `<a class="news-item" href="${esc(n.url)}" target="_blank" rel="noopener">` +
          `<div class="news-title">${esc(n.title)}</div>` +
          `<div class="news-meta">${esc(n.source || "news")} · ${relDays(n.date)}</div></a>`
      )
      .join("");
  }
  document.getElementById("line-card-more").innerHTML =
    (state.news?.generated
      ? `Headlines as of ${new Date(state.news.generated).toLocaleDateString("en-GB", {
          day: "2-digit", month: "short", year: "numeric",
        })}. `
      : "") +
    `<a href="${esc(searchUrl)}" target="_blank" rel="noopener">Search latest news ›</a>`;

  if (isMobile()) { closeStation(); setPanelCollapsed(true); }
}

function closeLineCard() {
  document.getElementById("line-card").hidden = true;
}

// ---------- alerts: confirmed advisories + unverified news signals ----------
//
// A disruption at 09:30 that a rider checks at 11:00 must not silently vanish,
// and an absence of alerts must never imply "all normal" — it can only ever
// mean "nothing known as of <the last scan>". Both facts are shown.

const RECENT_WINDOW_MS = 3 * 3600 * 1000; // keep showing an ended alert this long
const SCAN_STALE_MS = 90 * 60 * 1000; // after this, say so out loud

const fmtClockOf = (ms) =>
  new Date(ms).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
function fmtAgo(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60 ? `${m % 60} min ` : ""}ago`;
}

// active now, or ended recently enough that a rider still needs to know
function classifyAlert(it, now) {
  const from = it.from ? Date.parse(it.from) : null;
  const to = it.to ? Date.parse(it.to) : null;
  if (from && from > now) return null; // not started yet
  if (to && to < now) {
    if (now - to > RECENT_WINDOW_MS) return null; // long over
    return { ...it, state: "recent", at: from };
  }
  return { ...it, state: "active", at: from };
}

// Alert data is read straight from the repo's raw endpoint rather than from
// the deployed copy. A GitHub Pages deploy on this repo takes 10+ minutes,
// which is far too slow for "is the metro broken right now"; raw is served
// with a 5-minute cache, so a scan (or a hand-edited advisory) goes live in
// about that. Everything else — timetable, geometry, news — changes daily at
// most and rides along with the normal deploy.
const RAW_DATA_BASE =
  "https://raw.githubusercontent.com/Dayamaya-K/blr-metro-live/main/data";

async function loadAlerts() {
  // raw first, then the deployed copy (covers offline/local dev, a renamed
  // repo, or raw.githubusercontent.com being unreachable)
  const grab = async (file) => {
    for (const base of [RAW_DATA_BASE, "data"]) {
      try {
        const res = await fetch(`${base}/${file}?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) continue;
        return await res.json();
      } catch {
        /* try the next source */
      }
    }
    return null;
  };
  const [adv, sig] = await Promise.all([grab("advisories.json"), grab("signals.json")]);
  const now = Date.now();

  state.signalsMeta = sig;
  state.advisories = [
    ...(adv?.items ?? []).map((it) => ({ ...it, confidence: "confirmed" })),
    ...(sig?.items ?? []).map((it) => ({ ...it, confidence: "unverified" })),
  ]
    .map((it) => classifyAlert(it, now))
    .filter(Boolean)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  state.alertsCheckedAt = now;
  renderAlerts();
  state.lastBoardSec = -1; // boards re-render with warnings
}

function renderAlerts() {
  const el = document.getElementById("advisories");
  el.innerHTML = state.advisories
    .map((it) => {
      const unverified = it.confidence === "unverified";
      const cls = unverified ? "unverified" : it.severity ?? "info";
      const when = it.at
        ? `<span class="adv-when">Reported ${fmtClockOf(it.at)} · ${fmtAgo(it.at)}</span>`
        : "";
      const tag = unverified
        ? `<span class="adv-tag">Unconfirmed report</span>`
        : `<span class="adv-tag">BMRCL advisory</span>`;
      const resolved =
        it.state === "recent"
          ? `<span class="adv-when">May be resolved — status unconfirmed</span>`
          : "";
      return (
        `<div class="advisory ${esc(cls)}">${tag}` +
        `<div class="adv-title">⚠ ${esc(it.title)}</div>` +
        (it.detail ? `<div>${esc(it.detail)}</div>` : "") +
        when + resolved +
        `<div class="adv-links">` +
        (it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">source</a> · ` : "") +
        `<a href="https://x.com/OfficialBMRCL" target="_blank" rel="noopener">verify @OfficialBMRCL</a>` +
        `</div></div>`
      );
    })
    .join("");

  // The honest status line: absence of alerts is only as good as the last scan.
  const scanned = state.signalsMeta?.generated ? Date.parse(state.signalsMeta.generated) : null;
  const statusEl = document.getElementById("alert-status");
  if (!scanned) {
    statusEl.className = "alert-status stale";
    statusEl.innerHTML =
      `Disruption feed unavailable — this map shows <b>scheduled</b> times only. ` +
      `<a href="https://x.com/OfficialBMRCL" target="_blank" rel="noopener">Check @OfficialBMRCL</a>`;
  } else if (Date.now() - scanned > SCAN_STALE_MS) {
    statusEl.className = "alert-status stale";
    statusEl.innerHTML =
      `⚠ Disruption check last ran ${fmtClockOf(scanned)} (${fmtAgo(scanned)}) — a newer ` +
      `disruption would not show here. ` +
      `<a href="https://x.com/OfficialBMRCL" target="_blank" rel="noopener">Check @OfficialBMRCL</a>`;
  } else if (state.advisories.length === 0) {
    statusEl.className = "alert-status ok";
    statusEl.innerHTML = `✓ No disruptions reported · checked ${fmtClockOf(scanned)}`;
  } else {
    statusEl.className = "alert-status";
    statusEl.innerHTML = `Checked ${fmtClockOf(scanned)}`;
  }

  // per-line badges (any alert, confirmed or not)
  state.disruptedLines = new Set(
    state.advisories.flatMap((it) => (it.lines?.length ? it.lines : ["purple", "green", "yellow"]))
  );
  state.confirmedDisrupted = new Set(
    state.advisories
      .filter((it) => it.confidence === "confirmed" && it.state === "active")
      .flatMap((it) => (it.lines?.length ? it.lines : ["purple", "green", "yellow"]))
  );
  for (const sim of state.sims) {
    const badge = document.getElementById(`adv-${sim.line.id}`);
    if (badge) badge.hidden = !state.disruptedLines.has(sim.line.id);
  }
}

// ---------- nearest station ----------

function wireGeo() {
  const btn = document.getElementById("btn-geo");
  const status = document.getElementById("geo-status");
  btn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      status.textContent = "Geolocation isn't available in this browser.";
      return;
    }
    status.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        state.userPos = { lat, lon };
        if (state.userMarker) state.userMarker.remove();
        state.userMarker = L.circleMarker([lat, lon], {
          radius: 7,
          color: "#14110e",
          weight: 2,
          fillColor: "#3572b0",
          fillOpacity: 1,
        })
          .bindTooltip("You are here", { direction: "top", className: "stn-tip" })
          .addTo(map);
        let best = null, bd = Infinity;
        for (const e of state.allStations) {
          const d = distM(lat, lon, e.s.lat, e.s.lon);
          if (d < bd) { bd = d; best = e; }
        }
        status.textContent = `Nearest station: ${best.s.name} (~${fmtDist(bd)})`;
        map.fitBounds(
          [
            [lat, lon],
            [best.s.lat, best.s.lon],
          ],
          { padding: [70, 70], maxZoom: 15 }
        );
        openStation(best, false);
      },
      (err) => {
        status.textContent =
          err.code === 1
            ? "Location permission denied — search for your station instead."
            : "Couldn't get your location.";
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

// ---------- timetable overlay ----------

function wireTimetable() {
  const overlay = document.getElementById("tt-overlay");
  const body = document.getElementById("tt-body");

  let html = "";
  for (const sim of state.sims) {
    const { line, cfg } = sim;
    const from = line.stations[0].name;
    const to = line.stations[line.stations.length - 1].name;
    html +=
      `<div class="tt-line">` +
      `<div class="board-head"><span class="dot" style="background:${line.color}"></span>${line.name}</div>` +
      `<div class="tt-meta">${esc(from)} ↔ ${esc(to)} · ${(line.length / 1000).toFixed(1)} km · ` +
      `end to end ~${cfg.endToEndMin} min</div>` +
      `<table class="tt-table">`;

    const sched = state.sched?.lines?.[line.id];
    if (sched) {
      // exact GTFS timetable: first / last / trips per service day
      const dayNames = { monday: "Mon", weekday: "Tue–Sat", sunday: "Sun", holiday: "Holidays" };
      for (const key of ["monday", "weekday", "sunday", "holiday"]) {
        const d = sched[key];
        if (!d) continue;
        const all = [...d[0], ...d[1]];
        if (!all.length) continue;
        html +=
          `<tr><th>${dayNames[key]}</th>` +
          `<td>first ${fmtHM(Math.min(...all))} · last ${fmtHM(Math.max(...all))}</td>` +
          `<td>${all.length} trips</td></tr>`;
      }
    } else {
      const dayNames = { weekday: "Mon–Fri", saturday: "Sat", sunday: "Sun" };
      for (const [day, bands] of Object.entries(cfg.days)) {
        bands.forEach((b, i) => {
          html += `<tr>`;
          if (i === 0) html += `<th rowspan="${bands.length}">${dayNames[day] ?? day}</th>`;
          html += `<td>${b[0]} – ${b[1]}</td><td>every ${b[2]} min</td></tr>`;
        });
      }
    }
    html += `</table></div>`;
  }
  body.innerHTML = html;

  const src = document.getElementById("tt-src");
  if (state.sched) {
    src.innerHTML =
      ` Exact departures loaded from <a href="${esc(state.sched.url)}" target="_blank" rel="noopener">bmrcl-gtfs</a>` +
      (state.sched.feedVersion ? ` (feed ${esc(state.sched.feedVersion)})` : "") +
      `, transcribed from official BMRCL timetables. Intermediate-station times are interpolated.`;
  } else {
    src.textContent = " Running on modelled headway bands (GTFS timetable not loaded).";
  }

  document.getElementById("tt-open").addEventListener("click", (ev) => {
    ev.preventDefault();
    overlay.hidden = false;
  });
  document.getElementById("tt-close").addEventListener("click", () => (overlay.hidden = true));
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) overlay.hidden = true;
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !overlay.hidden) overlay.hidden = true;
  });
}

// ---------- search ----------

function wireSearch() {
  const input = document.getElementById("search");
  const box = document.getElementById("search-results");

  // unique by name; interchanges appear once
  const seen = new Set();
  const index = [];
  for (const e of state.allStations) {
    const k = e.s.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    index.push(e);
  }

  function render(q) {
    if (!q) { box.hidden = true; return; }
    const matches = index
      .filter((e) => e.s.name.toLowerCase().includes(q))
      .slice(0, 7);
    if (!matches.length) { box.hidden = true; return; }
    box.innerHTML = matches
      .map(
        (e, i) =>
          `<div class="sr-item${i === 0 ? " sel" : ""}" data-i="${state.allStations.indexOf(e)}">` +
          `<span class="dot" style="background:${e.color}"></span>${esc(e.s.name)}</div>`
      )
      .join("");
    box.hidden = false;
  }

  input.addEventListener("input", () => render(input.value.trim().toLowerCase()));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      const sel = box.querySelector(".sr-item");
      if (sel) sel.dispatchEvent(new Event("mousedown"));
    } else if (ev.key === "Escape") {
      box.hidden = true;
      input.blur();
    }
  });
  input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
  box.addEventListener("mousedown", (ev) => {
    const item = ev.target.closest(".sr-item");
    if (!item) return;
    const entry = state.allStations[+item.dataset.i];
    openStation(entry, true);
    box.hidden = true;
    input.value = entry.s.name;
  });
}

// ---------- controls ----------

function setLive(on) {
  state.live = on;
  if (on) state.playing = true;
  document.getElementById("btn-live").classList.toggle("active", on);
  document.getElementById("btn-pause").textContent = state.playing ? "❚❚" : "▶";
}

function wireControls() {
  document.getElementById("btn-live").addEventListener("click", () => {
    state.simMs = Date.now();
    setLive(true);
  });
  document.getElementById("btn-pause").addEventListener("click", () => {
    if (state.live) setLive(false);
    state.playing = !state.playing;
    document.getElementById("btn-pause").textContent = state.playing ? "❚❚" : "▶";
  });
  for (const btn of document.querySelectorAll("[data-speed]")) {
    btn.addEventListener("click", () => {
      state.speed = +btn.dataset.speed;
      setLive(false);
      state.playing = true;
      document.getElementById("btn-pause").textContent = "❚❚";
      for (const b of document.querySelectorAll("[data-speed]"))
        b.classList.toggle("active", b === btn);
    });
  }
  const slider = document.getElementById("time-slider");
  slider.addEventListener("pointerdown", () => (state.scrubbing = true));
  for (const ev of ["pointerup", "pointercancel", "change"])
    slider.addEventListener(ev, () => (state.scrubbing = false));
  slider.addEventListener("input", () => {
    const target = +slider.value;
    const cur = istInfo(state.simMs).sec;
    state.simMs += (target - cur) * 1000;
    setLive(false);
  });
}

// ---------- main loop ----------

// Positions update every animation frame so trains glide instead of hopping
// between 250 ms ticks; panel text (clock, counts, slider) only needs the
// slower cadence.
function frame(now) {
  // rAF pauses in background tabs — clamp dt so sim mode doesn't leap on return
  const dt = Math.min(now - state.lastTick, 1000);
  state.lastTick = now;

  if (state.live) state.simMs = Date.now();
  else if (state.playing) state.simMs += dt * state.speed;

  const info = fullInfo(state.simMs);
  const alive = new Set();
  const counts = {};

  for (const sim of state.sims) {
    const id = sim.line.id;
    counts[id] = 0;
    if (state.enabled[id]) {
      for (const t of sim.trainsAt(info)) {
        upsertTrain(t, now);
        alive.add(t.key);
        counts[id]++;
      }
    }
  }

  for (const [key, rec] of state.markers)
    if (!alive.has(key)) {
      // remove from the line's layer group, not just the map — otherwise the
      // group re-adds every historical marker when a line is toggled back on
      state.groups[rec.train.lineId].removeLayer(rec.marker);
      state.markers.delete(key);
    }

  if (now - state.lastSlow >= SLOW_MS) {
    state.lastSlow = now;
    slowUpdates(info, counts);
  }
  requestAnimationFrame(frame);
}

function slowUpdates(info, counts) {
  let total = 0;
  for (const sim of state.sims) {
    const id = sim.line.id;
    total += counts[id];
    const countEl = document.getElementById(`count-${id}`);
    if (countEl) countEl.textContent = counts[id];
    const hwEl = document.getElementById(`hw-${id}`);
    if (hwEl) {
      const hw = sim.headwayNow(info);
      hwEl.textContent = hw === "service ended" && counts[id] > 0 ? "last trains" : hw;
    }
  }

  document.getElementById("clock").textContent = info.clock;
  document.getElementById("date-label").textContent = `${info.dateLabel} · IST`;
  document.getElementById("total-count").textContent =
    total > 0 ? `${total} trains running` : "no trains in service";
  if (!state.scrubbing) document.getElementById("time-slider").value = info.sec;

  // departure board refreshes once per displayed second
  const boardSec = Math.floor(info.sec);
  if (state.selected && boardSec !== state.lastBoardSec) {
    state.lastBoardSec = boardSec;
    renderBoards(info);
  }
}

boot();
