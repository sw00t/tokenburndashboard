#!/usr/bin/env node
/**
 * extract-ollama.mjs
 *
 * Reads Ollama's server logs (~/.ollama/logs/server*.log) and writes
 * data/private/ollama-daily.json: per local day and model, the requests, the
 * prompt tokens evaluated, and the tokens generated. Labeled "exact": these
 * are the runner's own per-request counts.
 *
 * What the log gives, per request, from llama.cpp's timing lines:
 *   slot print_timing: ... | prompt eval time = 189.02 ms /    22 tokens (...)
 *   slot print_timing: ... |        eval time = 3406.04 ms /   259 tokens (...)
 * "prompt eval" counts only prompt tokens actually processed: when the runner
 * reuses a cached prompt prefix, the reused part is not logged, so there is no
 * cache-read figure for this lane.
 *
 * Which model: the most recent model line before the request, either
 * "model=registry.ollama.ai/library/<name:tag>" or a blob path, which is mapped
 * back to <name:tag> through ~/.ollama/models/manifests. With two models loaded
 * at once, requests could be credited to the last one loaded.
 *
 * Which day: timing lines carry no timestamp, and each request's "[GIN] date -
 * time" line is written just after them, so a request takes the date of the
 * next timestamped line. [GIN] times are the machine's local time; time= lines
 * carry an offset. Both are re-bucketed into BURN_TZ.
 *
 * Ollama keeps the current log plus a few rotated ones (rotating on restart),
 * so like the other extractors this merges with its previous output: days no
 * longer in the logs are kept, and a day seen again keeps the larger reading per
 * model. `--rebuild` ignores that history.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TZ, loadHistory, localDay, writeJsonAtomic } from "./lib/common.mjs";

const OLLAMA = path.join(os.homedir(), ".ollama");
const LOG_DIR = path.join(OLLAMA, "logs");
const OUT = path.resolve(process.cwd(), "data/private/ollama-daily.json");
const previous = loadHistory(OUT);

/** blob digest (hex) -> "name:tag", from the local model manifests. */
function blobNames() {
  const names = new Map();
  const root = path.join(OLLAMA, "models/manifests");
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      try {
        const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
        const model = (manifest.layers || []).find((l) => l.mediaType === "application/vnd.ollama.image.model");
        // .../manifests/<registry>/<namespace>/<name>/<tag>
        const [name, tag] = path.relative(root, p).split(path.sep).slice(-2);
        if (model?.digest) names.set(model.digest.replace(/^sha256:/, ""), `${name}:${tag}`);
      } catch { /* not a manifest */ }
    }
  };
  walk(root);
  return names;
}

// Oldest first: server-5.log ... server-1.log, then server.log.
const logFiles = fs.existsSync(LOG_DIR)
  ? fs.readdirSync(LOG_DIR)
    .filter((f) => /^server(-\d+)?\.log$/.test(f))
    .sort((a, b) => (Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0)))
  : [];

if (logFiles.length === 0 && !previous) {
  writeJsonAtomic(OUT, { available: false, reason: "no Ollama server logs found", generatedAt: new Date().toISOString(), timezone: TZ, days: [] });
  console.log("ollama: no server logs found; lane stays empty.");
  process.exit(0);
}

const digestToName = blobNames();
const scanned = new Map(); // date -> model -> { requests, prompt, generated }
const add = (date, model, field, n) => {
  if (!scanned.has(date)) scanned.set(date, new Map());
  const byModel = scanned.get(date);
  if (!byModel.has(model)) byModel.set(model, { requests: 0, prompt: 0, generated: 0 });
  byModel.get(model)[field] += n;
};

let requestCount = 0;
for (const file of logFiles) {
  let model = "unknown";
  let pending = []; // requests seen since the last timestamp: [{ model, prompt, generated }]
  const settle = (date) => {
    for (const r of pending) {
      add(date, r.model, "requests", 1);
      add(date, r.model, "prompt", r.prompt);
      add(date, r.model, "generated", r.generated);
    }
    pending = [];
  };
  let lastDate = null;
  for (const line of fs.readFileSync(path.join(LOG_DIR, file), "utf8").split("\n")) {
    let m = line.match(/model=registry\.ollama\.ai\/library\/(\S+)/);
    if (m) model = m[1];
    m = line.match(/model=\S*blobs\/sha256-([0-9a-f]{64})/);
    if (m && digestToName.has(m[1])) model = digestToName.get(m[1]);

    m = line.match(/prompt eval time =\s*[\d.]+ ms \/\s*(\d+) tokens/);
    if (m) { pending.push({ model, prompt: Number(m[1]), generated: 0 }); requestCount += 1; continue; }
    m = line.match(/\|\s+eval time =\s*[\d.]+ ms \/\s*(\d+) (?:tokens|runs)/);
    if (m && pending.length) { pending[pending.length - 1].generated += Number(m[1]); continue; }

    // Timestamps: "time=2026-11-25T07:39:23.018-08:00" (offset) or "[GIN] 2026/11/25 - 07:39:26" (machine local).
    m = line.match(/^time=(\S+)/);
    let when = m ? new Date(m[1]) : null;
    if (!when) {
      m = line.match(/^\[GIN\] (\d{4})\/(\d{2})\/(\d{2}) - (\d{2}:\d{2}:\d{2})/);
      if (m) when = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}`);
    }
    if (when && !Number.isNaN(when.getTime())) {
      lastDate = localDay(when);
      if (pending.length) settle(lastDate);
    }
  }
  if (pending.length && lastDate) settle(lastDate);
}

// ---------- Merge with history (per day and model, larger reading wins) ----------
const finalizeModel = (v) => ({ ...v, total: v.prompt + v.generated });
const days = new Map();
for (const d of previous?.days || []) days.set(d.date, { ...d.models });
let keptDays = 0;
for (const [date, byModel] of scanned) {
  const merged = days.get(date) || {};
  for (const [model, v] of byModel) {
    const next = finalizeModel(v);
    if (!merged[model] || next.total >= merged[model].total) merged[model] = next;
  }
  days.set(date, merged);
}
for (const d of previous?.days || []) if (!scanned.has(d.date)) keptDays += 1;

const rows = [...days.entries()]
  .map(([date, models]) => {
    const list = Object.values(models);
    const sum = (k) => list.reduce((s, v) => s + v[k], 0);
    return { date, requests: sum("requests"), prompt: sum("prompt"), generated: sum("generated"), total: sum("total"), models };
  })
  .filter((d) => d.total > 0)
  .sort((a, b) => a.date.localeCompare(b.date));

writeJsonAtomic(OUT, {
  available: true,
  generatedAt: new Date().toISOString(),
  timezone: TZ,
  runner: "ollama",
  source: "Ollama server logs: llama.cpp per-request timing lines",
  method: {
    prompt: "prompt tokens evaluated per request (a reused cached prefix is not logged)",
    generated: "tokens generated per request",
    day: "date of the next timestamped log line after the request",
  },
  logFiles: logFiles.length,
  days: rows,
});

const fmt = (n) => n.toLocaleString("en-US");
const total = rows.reduce((s, d) => s + d.total, 0);
console.log(`Wrote data/private/ollama-daily.json: ${rows.length} day(s) from ${logFiles.length} log file(s), ${requestCount} request(s) read now` +
  (keptDays ? `, ${keptDays} day(s) kept from earlier runs` : ""));
const perModel = {};
for (const d of rows) for (const [m, v] of Object.entries(d.models)) perModel[m] = (perModel[m] || 0) + v.total;
console.log(`ollama: ${fmt(total)} tokens | ${Object.entries(perModel).map(([m, t]) => `${m} ${fmt(t)}`).join(" | ")}`);
