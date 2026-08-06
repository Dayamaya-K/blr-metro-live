// Builds data/news.json — latest news headlines per metro line, shown when a
// user taps a future corridor on the map.
//
// Why baked into a file instead of fetched live: Google News RSS sends no CORS
// headers, so a static page (GitHub Pages) cannot read it from the browser.
// The GitHub Action refreshes this file on a schedule; the UI shows how old it
// is and links to a live search for anything newer.
//
// Usage: node tools/fetch_line_news.mjs [max-age-days, default 120]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_AGE_DAYS = Number(process.argv[2] ?? 120);
const PER_LINE = 5;

// Per line: the RSS search query, plus a regex the headline must match so we
// don't attribute a generic BMRCL story to a specific corridor.
const LINES = [
  { id: "pink",       query: '"Pink Line" (metro OR BMRCL OR Bengaluru)',            must: /pink line/i },
  { id: "blue",       query: '"Blue Line" Bengaluru (metro OR BMRCL OR airport)',    must: /blue line|airport metro|kia metro/i },
  { id: "green-ext",  query: 'Namma Metro Green Line extension (Madavara OR Anjanapura OR "phase 2")', must: /green line/i },
  { id: "orange",     query: '"Orange Line" Bengaluru metro OR "Namma Metro Phase 3"', must: /orange line|phase 3/i },
  { id: "red",        query: 'Sarjapur Hebbal metro line Bengaluru OR "Red Line" Namma Metro', must: /sarjapur|red line/i },
  { id: "kadabagere", query: 'Hosahalli Kadabagere metro Bengaluru',                  must: /kadabagere|hosahalli/i },
  // operational lines get news too — handy for the line rows in the panel
  { id: "purple",     query: '"Purple Line" Namma Metro Bengaluru',                   must: /purple line/i },
  { id: "green",      query: '"Green Line" Namma Metro Bengaluru',                    must: /green line/i },
  { id: "yellow",     query: '"Yellow Line" Namma Metro Bengaluru',                   must: /yellow line/i },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();

function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, body]) => {
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
}

async function fetchLine(line) {
  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(line.query) +
    "&hl=en-IN&gl=IN&ceid=IN:en";
  const res = await fetch(url, { headers: { "User-Agent": "blr-metro-live/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
  const seen = new Set();
  return parseItems(await res.text())
    .filter((it) => {
      const ts = Date.parse(it.pubDate);
      if (!Number.isFinite(ts) || ts < cutoff) return false;
      if (!line.must.test(it.title)) return false;
      // Google appends " - Publisher"; dedupe on the story part
      const key = it.title.replace(/\s*-\s*[^-]+$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate))
    .slice(0, PER_LINE)
    .map((it) => ({
      title: it.title.replace(/\s*-\s*[^-]+$/, ""),
      source: it.source || (it.title.match(/-\s*([^-]+)$/)?.[1] ?? "").trim(),
      date: new Date(Date.parse(it.pubDate)).toISOString().slice(0, 10),
      url: it.link,
    }));
}

const out = { generated: new Date().toISOString(), maxAgeDays: MAX_AGE_DAYS, lines: {} };
for (const line of LINES) {
  try {
    const items = await fetchLine(line);
    out.lines[line.id] = items;
    console.log(`${line.id.padEnd(11)} ${items.length} items` +
      (items[0] ? `  latest: ${items[0].date} — ${items[0].title.slice(0, 70)}` : ""));
  } catch (e) {
    console.warn(`${line.id.padEnd(11)} failed: ${e.message}`);
    out.lines[line.id] = [];
  }
  await sleep(1200); // be polite to the feed
}

mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "news.json"), JSON.stringify(out));
console.log(`\nWrote data/news.json`);
