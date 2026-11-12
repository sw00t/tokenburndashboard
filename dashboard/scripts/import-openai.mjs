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
 * Overlapping exports are fine: later files overwrite the same day.
 *
 * Usage: node scripts/import-openai.mjs [folder]
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

const root = process.cwd();
const dir = path.resolve(process.argv[2] || process.env.OPENAI_EXPORT_DIR || path.join(root, "data/private/openai-exports"));
const OUT = path.join(root, "data/private/openai-daily.json");

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => Object.fromEntries(line.split(",").map((v, i) => [header[i], v])));
}
const num = (v) => (v === undefined || v === "" ? 0 : Number(v));

if (!fs.existsSync(dir)) {
  console.error(`No export folder at ${dir}. Pass a folder or set OPENAI_EXPORT_DIR.`);
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv"));
const usageFiles = files.filter((f) => f.startsWith("completions_usage_")).sort();
const costFiles = files.filter((f) => f.startsWith("cost_")).sort();

const days = new Map();
const day = (date) => {
  if (!days.has(date)) days.set(date, { date, requests: 0, input: 0, output: 0, cached: 0, cache_write: 0, total: 0, models: {}, cost_usd: 0 });
  return days.get(date);
};

// Usage: one row per (day, model, key). Aggregate across keys.
for (const f of usageFiles) {
  for (const r of parseCsv(fs.readFileSync(path.join(dir, f), "utf8"))) {
    if (!r.model) continue;
    const date = r.start_time_iso.slice(0, 10);
    const d = day(date);
    const input = num(r.input_tokens), output = num(r.output_tokens);
    d.requests += num(r.num_model_requests);
    d.input += input; d.output += output;
    d.cached += num(r.input_cached_tokens);
    d.cache_write += num(r.input_cache_write_tokens);
    d.total += input + output;
    d.models[r.model] = (d.models[r.model] || 0) + input + output;
  }
}
for (const f of costFiles) {
  for (const r of parseCsv(fs.readFileSync(path.join(dir, f), "utf8"))) {
    if (!r.amount_value) continue;
    day(r.start_time_iso.slice(0, 10)).cost_usd += num(r.amount_value);
  }
}

const rows = [...days.values()].filter((d) => d.total > 0 || d.cost_usd > 0).sort((a, b) => a.date.localeCompare(b.date));
for (const d of rows) d.cost_usd = Math.round(d.cost_usd * 10000) / 10000;

const out = {
  generatedAt: new Date().toISOString(),
  source: "OpenAI platform usage export CSVs",
  bucket: "UTC day as exported (no hourly detail available to re-bucket)",
  fidelity: "billed",
  covers: "API-key traffic only. ChatGPT chat and Codex on a ChatGPT subscription are not in these exports.",
  files: { usage: usageFiles, cost: costFiles },
  days: rows,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

const sum = (k) => rows.reduce((s, d) => s + d[k], 0);
console.log(`Wrote data/private/openai-daily.json: ${rows.length} day(s) from ${usageFiles.length} usage + ${costFiles.length} cost file(s)`);
console.log(`openai api: ${sum("total").toLocaleString()} tokens (${sum("input").toLocaleString()} in / ${sum("output").toLocaleString()} out, ${sum("cached").toLocaleString()} cached), ${sum("requests")} requests, $${sum("cost_usd").toFixed(4)}`);
for (const d of rows) console.log(`  ${d.date}  ${String(d.total).padStart(7)} tokens  ${String(d.requests).padStart(3)} req  $${d.cost_usd.toFixed(4)}  ${Object.keys(d.models).join(", ")}`);
