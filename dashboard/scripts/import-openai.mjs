#!/usr/bin/env node
/**
 * import-openai.mjs
 *
 * Reads OpenAI platform usage exports (platform.openai.com > Usage > Export)
 * and writes data/private/openai-daily.json. This is OpenAI's own meter, so
 * the lane is labeled "billed". It covers API keys only: ChatGPT chat and
 * Codex-on-subscription never appear in these exports.
 *
 * Input: a folder holding any number of
 *   completions_usage_<from>_<to>.csv   per-day, per-model token counts
 *   cost_<from>_<to>.csv                per-day USD
 *
 * Overlapping exports: each day is taken whole from ONE file, the most recent
 * export (latest <to>, then latest <from>) that has rows for that day. Rows are
 * never added across files, so the same day exported twice counts once.
 *
 * History: days already in openai-daily.json that no export in the folder
 * covers any more are kept (marked preservedFrom). Removing an old CSV from the
 * folder therefore never deletes its days. `--rebuild` ignores that history.
 *
 * Usage: node scripts/import-openai.mjs [folder] [--rebuild]
 *   folder defaults to $OPENAI_EXPORT_DIR, then data/private/openai-exports/
 *
 * Buckets are UTC days as exported. OpenAI does not publish hourly detail in
 * these files, so the local-day re-bucketing used elsewhere is not possible;
 * the fidelity note records that.
 *
 * Privacy: org, project, user, and key ids in the CSVs are read and dropped.
 * Only date, model, token counts, request counts, and USD are kept.
 */
import fs from "node:fs";
import path from "node:path";

import { loadHistory, writeJsonAtomic } from "./lib/common.mjs";

const root = process.cwd();
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const REBUILD = process.argv.includes("--rebuild");
const dir = path.resolve(positional[0] || process.env.OPENAI_EXPORT_DIR || path.join(root, "data/private/openai-exports"));
const OUT = path.join(root, "data/private/openai-daily.json");

/**
 * RFC 4180 parsing: quoted fields may hold commas, newlines, and doubled
 * quotes. OpenAI's cost export quotes line items such as "gpt-5-mini, input",
 * which a plain split(",") would shift into the wrong columns.
 */
function parseCsv(text) {
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { record.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field); field = "";
      if (record.some((v) => v.trim())) records.push(record);
      record = [];
    } else field += c;
  }
  record.push(field);
  if (record.some((v) => v.trim())) records.push(record);
  if (records.length === 0) return [];
  const header = records[0].map((h) => h.trim().replace(/^﻿/, ""));
  return records.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
const num = (v) => (v === undefined || v === "" ? 0 : Number(v));

/** Sort key from <prefix>_<from>_<to>.csv: newest export last. */
function exportRange(file) {
  const m = file.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/);
  return m ? { from: m[1], to: m[2] } : { from: "", to: "" };
}
const byRecency = (a, b) => {
  const [x, y] = [exportRange(a), exportRange(b)];
  return x.to.localeCompare(y.to) || x.from.localeCompare(y.from) || a.localeCompare(b);
};

if (!fs.existsSync(dir)) {
  console.error(`No export folder at ${dir}. Pass a folder or set OPENAI_EXPORT_DIR. Stored days are unchanged.`);
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv"));
const usageFiles = files.filter((f) => f.startsWith("completions_usage_")).sort(byRecency);
const costFiles = files.filter((f) => f.startsWith("cost_")).sort(byRecency);

/**
 * Aggregate one file into per-day buckets, then let it replace any earlier
 * file's buckets for the days it has rows for.
 */
function collect(fileList, perRow) {
  const winner = new Map(); // date -> { file, bucket }
  for (const f of fileList) {
    const own = new Map();
    for (const r of parseCsv(fs.readFileSync(path.join(dir, f), "utf8"))) {
      const date = (r.start_time_iso || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!own.has(date)) own.set(date, {});
      perRow(own.get(date), r);
    }
    for (const [date, bucket] of own) winner.set(date, { file: f, bucket });
  }
  return winner;
}

const usage = collect(usageFiles, (b, r) => {
  if (!r.model) return;
  const input = num(r.input_tokens), output = num(r.output_tokens);
  b.requests = (b.requests || 0) + num(r.num_model_requests);
  b.input = (b.input || 0) + input;
  b.output = (b.output || 0) + output;
  b.cached = (b.cached || 0) + num(r.input_cached_tokens);
  b.cache_write = (b.cache_write || 0) + num(r.input_cache_write_tokens);
  b.models = b.models || {};
  b.models[r.model] = (b.models[r.model] || 0) + input + output;
});
const cost = collect(costFiles, (b, r) => {
  if (r.amount_value === "" || r.amount_value === undefined) return;
  b.cost_usd = (b.cost_usd || 0) + num(r.amount_value);
});

const fresh = new Map();
for (const date of new Set([...usage.keys(), ...cost.keys()])) {
  const u = usage.get(date)?.bucket || {};
  const c = cost.get(date)?.bucket || {};
  const input = u.input || 0, output = u.output || 0;
  fresh.set(date, {
    date,
    requests: u.requests || 0,
    input, output,
    cached: u.cached || 0,
    cache_write: u.cache_write || 0,
    total: input + output,
    models: u.models || {},
    cost_usd: Math.round((c.cost_usd || 0) * 10000) / 10000,
    from_files: { usage: usage.get(date)?.file || null, cost: cost.get(date)?.file || null },
  });
}

const previous = loadHistory(OUT); // null with --rebuild
let kept = 0;
const merged = new Map(fresh);
for (const p of previous?.days || []) {
  if (merged.has(p.date)) continue;
  merged.set(p.date, { ...p, preservedFrom: p.preservedFrom || previous.generatedAt });
  kept += 1;
}
const rows = [...merged.values()].filter((d) => d.total > 0 || d.cost_usd > 0).sort((a, b) => a.date.localeCompare(b.date));

const out = {
  generatedAt: new Date().toISOString(),
  source: "OpenAI platform usage export CSVs",
  bucket: "UTC day as exported (no hourly detail available to re-bucket)",
  fidelity: "billed",
  covers: "API-key traffic only. ChatGPT chat and Codex on a ChatGPT subscription are not in these exports.",
  merge: REBUILD
    ? "rebuilt from the export folder only (--rebuild)"
    : "each day from the most recent export that has it; days no export covers any more are kept from history",
  files: { usage: usageFiles, cost: costFiles },
  days: rows,
};
writeJsonAtomic(OUT, out);

const sum = (k) => rows.reduce((s, d) => s + d[k], 0);
console.log(`Wrote data/private/openai-daily.json: ${rows.length} day(s) from ${usageFiles.length} usage + ${costFiles.length} cost file(s)` +
  (kept ? `, ${kept} kept from earlier imports` : ""));
console.log(`openai api: ${sum("total").toLocaleString()} tokens (${sum("input").toLocaleString()} in / ${sum("output").toLocaleString()} out, ${sum("cached").toLocaleString()} cached), ${sum("requests")} requests, $${sum("cost_usd").toFixed(4)}`);
for (const d of rows) console.log(`  ${d.date}  ${String(d.total).padStart(7)} tokens  ${String(d.requests).padStart(3)} req  $${d.cost_usd.toFixed(4)}  ${Object.keys(d.models).join(", ")}${d.preservedFrom ? "  (kept)" : ""}`);
