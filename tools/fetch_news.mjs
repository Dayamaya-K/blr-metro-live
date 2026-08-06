// Scans Google News RSS for possible Namma Metro service disruptions and
// writes data/signals.json — UNVERIFIED reports surfaced to riders as soft,
// clearly-labelled warnings.
//
// Two-tier design, on purpose:
//   data/advisories.json — human-vetted, shown as authoritative
//   data/signals.json    — machine-scanned, shown as "unconfirmed report"
// Speed without the label would be misinformation; the label is what makes
// publishing unvetted signals acceptable.
//
// Usage: node tools/fetch_news.mjs [hours-back, default 12]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOURS = Number(process.argv[2] ?? 12);
const ASSUME_RESOLVED_HOURS = 6; // a report goes stale unless renewed

const FEED =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent('("Namma Metro" OR BMRCL OR "Bengaluru Metro") (delay OR disruption OR halted OR suspended OR snag OR glitch OR breakdown)') +
  "&hl=en-IN&gl=IN&ceid=IN:en";

// must look like an operational incident …
const DISRUPTION =
  /disrupt|delay|halt|suspend|stall|glitch|snag|breakdown|technical|derail|smoke|fire|power failure|服务|stuck|stranded|curtail|partial(?:ly)? clos|shut(?:down)?|not running|服/i;
// … and must NOT be one of the many non-operational stories that use the same
// vocabulary ("project delayed", "MD appointed as metro races to fix delays")
const NOT_OPERATIONAL =
  /appoint|managing director|\bMD\b|tender|contract|funding|budget|approval|land acquisition|trees?\b|deadline|races to|project delay|delayed project|behind schedule|cost overrun|will open|to open|inaugurat|opening date|phase \d|dpr\b|survey|feasibilit/i;

const LINE_WORDS = [
  ["purple", /purple/i],
  ["green", /green line/i],
  ["yellow", /yellow line/i],
];

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

const res = await fetch(FEED, { headers: { "User-Agent": "blr-metro-live/1.0" } });
if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status}`);
const xml = await res.text();

const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, body]) => {
  const pick = (tag) =>
    (body.match(
      new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)
    ) ?? [])[1] ?? "";
  return {
    title: decode(pick("title")),
    link: pick("link").trim(),
    pubDate: pick("pubDate"),
    source: decode(pick("source")),
  };
});

const cutoff = Date.now() - HOURS * 3600_000;
const seen = new Set();
const signals = [];
const rejected = [];
for (const it of items) {
  const ts = Date.parse(it.pubDate);
  const bare = it.title.replace(/\s*-\s*[^-]+$/, "");
  if (!Number.isFinite(ts) || ts < cutoff) continue;
  if (!DISRUPTION.test(bare)) continue;
  if (NOT_OPERATIONAL.test(bare)) {
    rejected.push(`[not operational] ${bare}`);
    continue;
  }
  const key = bare.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  signals.push({
    title: bare,
    source: it.source || (it.title.match(/-\s*([^-]+)$/)?.[1] ?? "").trim(),
    lines: LINE_WORDS.filter(([, re]) => re.test(bare)).map(([id]) => id),
    confidence: "unverified",
    url: it.link,
    from: new Date(ts).toISOString(),
    to: new Date(ts + ASSUME_RESOLVED_HOURS * 3600_000).toISOString(),
  });
}
signals.sort((a, b) => Date.parse(b.from) - Date.parse(a.from));

mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(
  join(ROOT, "data", "signals.json"),
  JSON.stringify({
    generated: new Date().toISOString(),
    windowHours: HOURS,
    assumeResolvedHours: ASSUME_RESOLVED_HOURS,
    note: "Machine-scanned news headlines, NOT confirmed by BMRCL. Shown to users as unverified reports.",
    items: signals,
  })
);

console.log(`${items.length} headlines scanned (last ${HOURS}h) -> ${signals.length} signals`);
for (const s of signals) console.log(`  • [${s.lines.join(",") || "network"}] ${s.title}`);
for (const r of rejected.slice(0, 8)) console.log(`  ${r}`);
console.log(`\nWrote data/signals.json`);
console.log(
  "These publish as UNVERIFIED. To promote one to a confirmed advisory, verify via\n" +
    "@OfficialBMRCL and add it to data/advisories.json with an explicit from/to."
);
