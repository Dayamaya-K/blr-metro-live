// Fetches Namma Metro line geometry + stations from OpenStreetMap (Overpass API)
// and bakes them into data/network.json for the web app.
//
// Usage: node tools/fetch_osm.mjs

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const QUERY = `
[out:json][timeout:180];
relation["route"="subway"]["network"~"Namma Metro",i]->.r;
(.r; .r >;);
out body;
`;

// Which OSM route relations map to which app line, matched against relation name/colour.
const LINES = [
  { id: "purple", match: /purple/i, name: "Purple Line", color: "#8e4a9e" },
  { id: "green",  match: /green/i,  name: "Green Line",  color: "#00a651" },
  { id: "yellow", match: /yellow/i, name: "Yellow Line", color: "#f6c500" },
];

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function fetchOverpass() {
  let lastErr;
  for (const url of MIRRORS) {
    console.log(`Querying ${url} …`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "blr-metro-live/1.0 (personal project; contact: local)",
          Accept: "application/json",
        },
        body: "data=" + encodeURIComponent(QUERY),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`  failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

// Stitch a relation's ordered member ways into one continuous polyline.
// Ways may be stored in either orientation; connect by shared endpoint node id,
// falling back to nearest-endpoint distance when ids don't line up.
function stitchWays(wayIds, ways, nodes) {
  const chain = []; // node ids
  const wayNodeLists = wayIds
    .map((id) => ways.get(id))
    .filter(Boolean)
    .map((w) => w.nodes);

  for (const wnodes of wayNodeLists) {
    if (wnodes.length < 2) continue;
    if (chain.length === 0) {
      chain.push(...wnodes);
      continue;
    }
    const last = chain[chain.length - 1];
    const first = chain[0];
    let oriented = null;
    if (wnodes[0] === last) oriented = wnodes.slice(1);
    else if (wnodes[wnodes.length - 1] === last) oriented = wnodes.slice(0, -1).reverse();
    else if (wnodes[0] === first || wnodes[wnodes.length - 1] === first) {
      // way attaches to the chain start -> our chain began mid-line; flip the chain
      chain.reverse();
      const l2 = chain[chain.length - 1];
      oriented = wnodes[0] === l2 ? wnodes.slice(1) : wnodes.slice(0, -1).reverse();
    } else {
      // no shared id: pick the endpoint closest to chain end (tolerate small gaps)
      const pLast = nodes.get(last);
      const d0 = haversine(pLast, nodes.get(wnodes[0]));
      const d1 = haversine(pLast, nodes.get(wnodes[wnodes.length - 1]));
      const gap = Math.min(d0, d1);
      if (gap > 200) console.warn(`  ! gap of ${gap.toFixed(0)}m while stitching`);
      oriented = d0 <= d1 ? wnodes.slice() : wnodes.slice().reverse();
    }
    chain.push(...oriented);
  }
  // dedupe consecutive repeats, convert to coords
  const pts = [];
  let prev = null;
  for (const id of chain) {
    if (id === prev) continue;
    const n = nodes.get(id);
    if (!n) continue;
    pts.push([+n.lat.toFixed(6), +n.lon.toFixed(6)]);
    prev = id;
  }
  return pts;
}

// Project a point onto the polyline, return chainage (metres from start).
function chainageOf(pt, shape, cum) {
  let best = { d2: Infinity, chain: 0 };
  const cosLat = Math.cos(rad(pt.lat));
  for (let i = 0; i < shape.length - 1; i++) {
    const [aLat, aLon] = shape[i];
    const [bLat, bLon] = shape[i + 1];
    // planar approx (metres) — fine at city scale
    const ax = 0, ay = 0;
    const bx = (bLon - aLon) * cosLat * 111320;
    const by = (bLat - aLat) * 110540;
    const px = (pt.lon - aLon) * cosLat * 111320;
    const py = (pt.lat - aLat) * 110540;
    const len2 = bx * bx + by * by || 1e-9;
    let t = (px * bx + py * by) / len2;
    t = Math.max(0, Math.min(1, t));
    const dx = px - t * bx;
    const dy = py - t * by;
    const d2 = dx * dx + dy * dy;
    if (d2 < best.d2) best = { d2, chain: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  return best.chain;
}

function cumulative(shape) {
  const cum = [0];
  for (let i = 1; i < shape.length; i++) {
    cum.push(
      cum[i - 1] +
        haversine(
          { lat: shape[i - 1][0], lon: shape[i - 1][1] },
          { lat: shape[i][0], lon: shape[i][1] }
        )
    );
  }
  return cum;
}

// --future-only: keep the operational lines already in data/network.json and
// only refresh the under-construction corridors (much lighter Overpass query)
const FUTURE_ONLY = process.argv.includes("--future-only");

const outLines = [];
if (FUTURE_ONLY) {
  const existing = JSON.parse(readFileSync(join(ROOT, "data", "network.json"), "utf8"));
  outLines.push(...existing.lines);
  console.log(`Reusing ${outLines.length} operational lines from data/network.json`);
}

const data = FUTURE_ONLY ? { elements: [] } : await fetchOverpass();
const nodes = new Map();
const ways = new Map();
const rels = [];
for (const el of data.elements) {
  if (el.type === "node") nodes.set(el.id, el);
  else if (el.type === "way") ways.set(el.id, el);
  else if (el.type === "relation") rels.push(el);
}
if (!FUTURE_ONLY) {
  console.log(`Got ${rels.length} route relations, ${ways.size} ways, ${nodes.size} nodes`);
  for (const r of rels) console.log(`  rel ${r.id}: ${r.tags?.name ?? "?"}`);
}

for (const def of FUTURE_ONLY ? [] : LINES) {
  const candidates = rels.filter(
    (r) =>
      def.match.test(r.tags?.name ?? "") ||
      def.match.test(r.tags?.colour ?? "") ||
      def.match.test(r.tags?.ref ?? "")
  );
  if (candidates.length === 0) {
    console.warn(`No relation found for ${def.name}`);
    continue;
  }
  // one relation per direction — pick the one with the most stop members
  const rel = candidates
    .map((r) => ({
      r,
      stops: r.members.filter((m) => m.type === "node" && /^stop/.test(m.role ?? "")).length,
    }))
    .sort((a, b) => b.stops - a.stops)[0].r;
  console.log(`\n${def.name}: using relation ${rel.id} "${rel.tags?.name}"`);

  const wayIds = rel.members
    .filter((m) => m.type === "way" && !/platform/.test(m.role ?? ""))
    .map((m) => m.ref);
  const shape = stitchWays(wayIds, ways, nodes);
  const cum = cumulative(shape);
  const length = cum[cum.length - 1];

  const stopIds = rel.members
    .filter((m) => m.type === "node" && /^stop/.test(m.role ?? ""))
    .map((m) => m.ref);
  let stations = stopIds
    .map((id) => nodes.get(id))
    .filter(Boolean)
    .map((n) => ({
      name: n.tags?.name ?? "Station",
      lat: +n.lat.toFixed(6),
      lon: +n.lon.toFixed(6),
      d: 0,
    }));
  for (const s of stations) s.d = Math.round(chainageOf(s, shape, cum));

  // shape and stop list must run the same direction; flip shape if chainages descend
  const ascending =
    stations.filter((s, i) => i > 0 && s.d > stations[i - 1].d).length >=
    stations.length / 2;
  if (!ascending) {
    shape.reverse();
    const cum2 = cumulative(shape);
    for (const s of stations) s.d = Math.round(chainageOf(s, shape, cum2));
  }
  stations.sort((a, b) => a.d - b.d);

  console.log(`  ${stations.length} stations, ${(length / 1000).toFixed(2)} km`);
  console.log(`  ${stations[0]?.name} -> ${stations[stations.length - 1]?.name}`);

  outLines.push({
    id: def.id,
    name: def.name,
    color: def.color,
    length: Math.round(length),
    stations,
    shape,
  });
}

// ---- under-construction corridors (Pink, Blue, ...) --------------------
// These exist in OSM as bare railway=construction ways (no route relations),
// so we render each way as-is without stitching or stations.

// Two tiers: "construction" (steel in the ground) and "planned" (approved /
// proposed alignments, mapped in OSM as railway=proposed).
const BBOX = "12.6,77.2,13.45,78.0";
const FUTURE_QUERY = `
[out:json][timeout:180];
(
  relation["railway"="construction"]["construction"="subway"](${BBOX});
  way["railway"="construction"]["construction"="subway"](${BBOX});
  relation["proposed"="subway"](${BBOX});
  way["railway"="proposed"]["proposed"="subway"](${BBOX});
);
(._; >;);
out body;
`;
// order matters: "Green Line Phase 2 Extension" must hit green-ext, not blue
const FUTURE_STYLES = [
  { id: "green-ext", match: /green/i, color: "#57a06b", label: "Green Line extension" },
  { id: "pink", match: /pink/i, color: "#e05c8e", label: "Pink Line" },
  { id: "blue", match: /phase 2|blue|airport|orr/i, color: "#3572b0", label: "Blue Line" },
  { id: "orange", match: /orange|kempapura/i, color: "#e8862d", label: "Orange Line" },
  { id: "red", match: /\bred\b|sarjapur/i, color: "#d0453b", label: "Red Line" },
  { id: "kadabagere", match: /hosahalli|kadabagere/i, color: "#8f7bbd", label: "Hosahalli – Kadabagere" },
];
const FUTURE_FALLBACK = { id: "future", color: "#8a8175", label: "Future corridor" };
const styleFor = (name) =>
  FUTURE_STYLES.find((s) => s.match.test(name)) ?? FUTURE_FALLBACK;

// which tier an OSM element belongs to
const stageOf = (tags) =>
  tags?.railway === "construction" || tags?.construction === "subway"
    ? "construction"
    : "planned";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFuture() {
  let lastErr;
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      console.log(`Overpass busy — retrying in 60 s (round ${round + 1}/3)…`);
      await sleep(60000);
    }
    for (const url of MIRRORS) {
      console.log(`Future lines: querying ${url} …`);
      try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "blr-metro-live/1.0 (personal project; contact: local)",
          Accept: "application/json",
        },
        body: "data=" + encodeURIComponent(FUTURE_QUERY),
      });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        console.warn(`  failed: ${e.message}`);
        lastErr = e;
      }
    }
  }
  throw lastErr;
}

// Under-construction lines are mapped inconsistently (relations with jumbled
// ways, bare ways for Phase 2A/2B), so we render each way as its own dashed
// segment instead of stitching — unmapped gaps simply stay blank.
let future = null;
try {
  const fdata = await fetchFuture();
  const fnodes = new Map();
  const fways = new Map();
  const frels = [];
  for (const el of fdata.elements) {
    if (el.type === "node") fnodes.set(el.id, el);
    else if (el.type === "way") fways.set(el.id, el);
    else if (el.type === "relation") frels.push(el);
  }

  const labels = new Map(); // id -> {id, label, color, stage, termini}
  const wayStyle = new Map(); // wayId -> {style, stage} (first relation wins)
  const fstations = [];
  const seenStations = new Set();
  // construction relations first, so a corridor mapped in both tiers reads as
  // the more advanced one
  frels.sort((a, b) => (stageOf(a.tags) === "construction" ? -1 : 1) - (stageOf(b.tags) === "construction" ? -1 : 1));
  for (const rel of frels) {
    const style = styleFor(rel.tags?.name ?? "");
    const stage = stageOf(rel.tags);
    if (!labels.has(style.id))
      labels.set(style.id, {
        ...style,
        stage,
        // "Orange Line (Kempapura ⇔ JP Nagar Phase 4)" -> the bracketed part
        termini: (rel.tags?.name?.match(/\(([^)]+)\)/)?.[1] ?? "")
          .replace(/[⇔→]/g, "↔")
          .replace(/\bCental\b/g, "Central") // typo in the OSM relation name
          .replace(/\bKIA\b/g, "KIA Airport")
          .replace(/KIA Airport Airport/g, "KIA Airport"),
      });
    for (const m of rel.members)
      if (m.type === "way" && !/platform/.test(m.role ?? "") && !wayStyle.has(m.ref))
        wayStyle.set(m.ref, { style, stage });
    let stops = 0;
    for (const m of rel.members) {
      if (m.type !== "node" || !/^stop/.test(m.role ?? "")) continue;
      const n = fnodes.get(m.ref);
      if (!n || seenStations.has(m.ref)) continue;
      seenStations.add(m.ref);
      stops++;
      fstations.push({
        lineId: style.id,
        stage,
        name: (n.tags?.name ?? "Station").replace(/\s*\(.*Line\)$/i, ""),
        lat: +n.lat.toFixed(6),
        lon: +n.lon.toFixed(6),
      });
    }
    console.log(`  ${stage} rel ${rel.id}: "${rel.tags?.name}" -> ${style.label}, ${stops} new stops`);
  }

  const corridors = [];
  const toShape = (w) =>
    w.nodes
      .map((id) => fnodes.get(id))
      .filter(Boolean)
      .map((n) => [+n.lat.toFixed(6), +n.lon.toFixed(6)]);
  for (const [wid, { style, stage }] of wayStyle) {
    const w = fways.get(wid);
    if (!w) continue;
    const shape = toShape(w);
    if (shape.length >= 2) corridors.push({ id: style.id, stage, shape });
  }
  // bare ways (Phase 2A/2B etc.) not part of any relation
  const nameCounts = {};
  for (const el of fdata.elements) {
    if (el.type !== "way" || wayStyle.has(el.id)) continue;
    const t = el.tags ?? {};
    const isFuture =
      (t.railway === "construction" && t.construction === "subway") ||
      (t.railway === "proposed" && t.proposed === "subway");
    if (!isFuture) continue;
    const name = t.name ?? "";
    const stage = stageOf(t);
    nameCounts[`${stage}: ${name}`] = (nameCounts[`${stage}: ${name}`] ?? 0) + 1;
    const style = styleFor(name || (t.ref ?? ""));
    if (!labels.has(style.id)) labels.set(style.id, { ...style, stage, termini: "" });
    const shape = toShape(el);
    if (shape.length >= 2) corridors.push({ id: style.id, stage, shape });
  }
  console.log(`Bare future ways by name:`, nameCounts);
  future = {
    lines: [...labels.values()].map(({ id, label, color, stage, termini }) => ({
      id,
      label,
      color,
      stage,
      termini,
    })),
    corridors,
    stations: fstations,
  };
  const byStage = (s) => future.lines.filter((l) => l.stage === s).map((l) => l.label);
  console.log(
    `Kept ${corridors.length} corridor segments, ${fstations.length} future stations\n` +
      `  under construction: ${byStage("construction").join(", ") || "none"}\n` +
      `  planned: ${byStage("planned").join(", ") || "none"}`
  );
} catch (e) {
  console.warn(`Future lines fetch failed (${e.message}) — continuing without`);
}

const out = {
  generated: new Date().toISOString(),
  source: "OpenStreetMap via Overpass API (ODbL)",
  lines: outLines,
  future,
};
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "network.json"), JSON.stringify(out));
console.log(`\nWrote data/network.json (${outLines.length} lines)`);
