#!/usr/bin/env node
/**
 * build-rows.mjs
 *
 * Merges the private inputs into the two public files the dashboard imports:
 *   data/private/exact-daily.json       (extract-exact.mjs)        local Codex and Claude Code
 *   data/private/console-daily.json     (fetch-console.mjs)        Anthropic billed tokens and cost
 *   data/private/openai-daily.json      (import-openai.mjs)        OpenAI API export
 *   data/private/plan-usage-daily.json  (extract-plan-usage.mjs)   Claude plan meter
 *   data/private/ollama-daily.json      (extract-ollama.mjs)       local models run through Ollama
 *   data/private/estimates.json         (hand-maintained)          chat estimates, drivers, evidence
 * ->
 *   data/daily-burn.json   one scrubbed row per day
 *   data/burn-meta.json    per-lane freshness (see the bottom of this file)
 *
 * Public row shape (starter contract plus a few labeled extras):
 *   date, codex_tokens, claude_code_tokens, claude_code_calls,
 *   claude_chat_est, chatgpt_est, total, driver, evidence,
 *   codex_cached, claude_code_cached          <- cache-read subset of the exact columns
 *   codex_fidelity, claude_code_fidelity      <- billed | exact | derived | estimated | none
 *   chat_fidelity                              <- estimated | none
 *   console_tokens, console_cached             <- Console-metered API usage with no local log
 *   console_fidelity                           <- billed | none
 *   openai_api_tokens, openai_api_cached       <- OpenAI platform export (import-openai.mjs), UTC days
 *   openai_api_requests, openai_api_usd, openai_api_models, openai_api_fidelity <- billed | none
 *   codex_models, claude_code_models          <- per-model split of the local lanes
 *   local_model_tokens, local_model_requests   <- models run on this machine (extract-ollama.mjs)
 *   local_model_models, local_model_fidelity   <- keyed "<runner>:<model>", e.g. "ollama:llama3.2:3b" (runner = text before the first colon); exact | none
 *   claude_plan_5h_pct, claude_plan_7d_pct    <- subscription meter peaks per day (extract-plan-usage.mjs)
 *   cost_usd, cost_cached_usd, cost_fidelity   <- real money, from the cost endpoint
 *   billed_claude_code_tokens                  <- reconciliation only, never summed into total
 *   anthropic_billed_tokens                    <- raw Console meter (overlap included), the denominator for cost per token
 */
import fs from "node:fs";
import path from "node:path";

import { readJsonIfExists } from "./lib/common.mjs";

const root = process.cwd();
const privateFile = (name) => path.join(root, "data/private", name);

const exact = JSON.parse(fs.readFileSync(privateFile("exact-daily.json"), "utf8"));
const est = readJsonIfExists(privateFile("estimates.json"), { sources: {}, days: {} });
const console_ = readJsonIfExists(privateFile("console-daily.json"));
const openai = readJsonIfExists(privateFile("openai-daily.json"));
const plan = readJsonIfExists(privateFile("plan-usage-daily.json"));
const ollama = readJsonIfExists(privateFile("ollama-daily.json"));

const byDate = (days) => new Map((days || []).map((d) => [d.date, d]));
const exactByDate = byDate(exact.days);
const consoleByDate = byDate(console_?.days);
const openaiByDate = byDate(openai?.days);
const planByDate = byDate(plan?.days);
const ollamaByDate = byDate(ollama?.days);
/**
 * Does Console-metered usage overlap the local Claude Code logs?
 * Only when Claude Code is billed as an API customer. On a Pro/Max/Team
 * subscription, Claude Code traffic never reaches the usage endpoint, so there
 * is nothing to subtract.
 */
const claudeCodeIsBilled = (console_?.claudeCodeCustomerTypes || []).includes("api");

const dates = new Set([
  ...exactByDate.keys(),
  ...Object.keys(est.days || {}),
  ...consoleByDate.keys(),
  ...openaiByDate.keys(),
  ...ollamaByDate.keys(),
]);

function ruleFor(date) {
  return (est.driverRules || []).find((r) => date >= r.from && date <= (r.to || r.from));
}
/**
 * A day's work does not always belong to one driver. `driver_split` assigns
 * fractions ({shipping: 0.6, research: 0.4}); shares are normalised so they sum
 * to 1, and `driver` stays the largest share so single-label views (the table,
 * the peak-day heading) still have one honest answer.
 */
function normalizeSplit(split) {
  if (!split) return null;
  const entries = Object.entries(split).filter(([, v]) => Number(v) > 0);
  if (entries.length === 0) return null;
  const sum = entries.reduce((s, [, v]) => s + Number(v), 0);
  return Object.fromEntries(entries.map(([k, v]) => [k, Number(v) / sum]));
}
function dominant(split) {
  return Object.entries(split).sort((a, b) => b[1] - a[1])[0][0];
}
/** A per-day override wins; otherwise the source's active/idle rate, or 0 if the source is excluded. */
function chatEstimate(sourceKey, active, dayOverride) {
  if (typeof dayOverride === "number") return dayOverride;
  const src = est.sources?.[sourceKey];
  if (!src || !src.include) return 0;
  return active ? src.per_active_day || 0 : src.per_idle_day || 0;
}
// Public evidence must not carry paths, emails, ids, or secrets.
const leakPattern = /(\/[\w.-]+\/|@|https?:|sk-|key|token=|[0-9a-f]{8}-[0-9a-f]{4}-)/i;
function scrub(text) {
  if (!text) return "";
  if (leakPattern.test(text)) throw new Error(`evidence_public looks private, refusing to publish: "${text}"`);
  return text;
}

/** Cents in, dollars out, kept to 4 decimals. */
const usd4 = (cents) => Math.round(cents * 100) / 10000;
const rows = [];
for (const date of [...dates].sort()) {
  const ex = exactByDate.get(date);
  const day = est.days?.[date] || {};
  const rule = ruleFor(date);
  const con = consoleByDate.get(date);
  const oa = openaiByDate.get(date);
  const pl = planByDate.get(date);
  const codex = ex?.codex?.total || 0;
  const cc = ex?.claude_code?.total || 0;

  // ---- Console (billed) lane -------------------------------------------
  // Everything the Console metered, minus the part already counted by the
  // local Claude Code logs, so the two lanes never double-count the same call.
  const billedTotal = con?.usage_total || 0;
  const billedCached = con?.usage?.cache_read || 0;
  const billedClaudeCodeTokens = con?.claude_code
    ? (con.claude_code.input || 0) + (con.claude_code.output || 0)
      + (con.claude_code.cache_read || 0) + (con.claude_code.cache_creation || 0)
    : 0;
  const overlap = claudeCodeIsBilled ? Math.min(billedTotal, billedClaudeCodeTokens) : 0;
  const overlapCached = claudeCodeIsBilled
    ? Math.min(billedCached, con?.claude_code?.cache_read || 0)
    : 0;
  const consoleTokens = Math.max(0, billedTotal - overlap);
  const consoleCached = Math.max(0, billedCached - overlapCached);

  // Model ids are public identifiers, so the per-model split is safe to publish.
  // Scale it by the same overlap ratio applied to console_tokens, so the model
  // rows sum to the lane they describe rather than to the raw meter.
  const rawModels = con?.usage?.models || {};
  const rawModelTotal = Object.values(rawModels).reduce((s, v) => s + v, 0);
  const modelScale = rawModelTotal ? consoleTokens / rawModelTotal : 0;
  const consoleModels = {};
  for (const [model, tokens] of Object.entries(rawModels)) {
    const scaled = Math.round(tokens * modelScale);
    if (scaled > 0) consoleModels[model] = scaled;
  }

  // ---- Money -----------------------------------------------------------
  // amount fields are decimal strings of cents; token_type is a closed enum.
  const costCents = con?.cost?.cents || 0;
  const cachedCostCents = con?.cost?.byTokenType?.cache_read_input_tokens || 0;

  const driverSplit = normalizeSplit(day.driver_split || rule?.driver_split);
  const driverLabel =
    day.driver || rule?.driver || (driverSplit ? dominant(driverSplit) : est.defaultDriver || "unlabeled");

  // ---- OpenAI API (billed) lane ------------------------------------------
  // Key-based traffic from the platform export. Independent of Codex (which
  // runs on the ChatGPT subscription) so there is no overlap to subtract.
  const openaiTokens = oa?.total || 0;
  const openaiCached = Math.min(openaiTokens, oa?.cached || 0);
  const openaiUsd = oa?.cost_usd || 0;

  // ---- Local models (exact) lane -----------------------------------------
  // Runner-reported counts for models on this machine; free, so no money.
  // Model keys carry the runner before the first colon ("ollama:llama3.2:3b") so the dashboard
  // can label them; no slash, so the public file still passes the deploy scrub.
  const ol = ollamaByDate.get(date);
  const localTokens = ol?.total || 0;
  const localModels = Object.fromEntries(Object.entries(ol?.models || {}).map(([m, v]) => [`ollama:${m}`, v.total]));

  // "Active" means you were at the keyboard: Codex or Claude Code sessions. The
  // API lanes are left out on purpose, because a scheduled job calling the API
  // says nothing about whether you also chatted that day. Counting them once put
  // 120K of estimated chat on every day a weekly background job ran. Local
  // models are left out for the same reason: scripts call them too.
  const active = codex + cc > 0;
  const claudeChat = chatEstimate("claude_chat", active, day.claude_chat_est);
  const chatgpt = chatEstimate("chatgpt", active, day.chatgpt_est);
  const total = codex + cc + consoleTokens + openaiTokens + localTokens + claudeChat + chatgpt;
  if (total === 0 && costCents === 0 && openaiUsd === 0) continue;
  rows.push({
    date,
    codex_tokens: codex,
    claude_code_tokens: cc,
    claude_code_calls: ex?.claude_code?.calls || 0,
    claude_chat_est: claudeChat,
    chatgpt_est: chatgpt,
    console_tokens: consoleTokens,
    openai_api_tokens: openaiTokens,
    local_model_tokens: localTokens,
    local_model_requests: ol?.requests || 0,
    total,
    driver: driverLabel,
    ...(driverSplit ? { driver_split: driverSplit } : {}),
    evidence: scrub(day.evidence_public || rule?.evidence_public || ""),
    codex_cached: ex?.codex?.cached || 0,
    claude_code_cached: ex?.claude_code?.cached || 0,
    console_cached: consoleCached,
    openai_api_cached: openaiCached,
    openai_api_requests: oa?.requests || 0,
    openai_api_usd: openaiUsd,
    // Four decimals of a dollar. Rounding each day to whole cents before summing
    // drifted the window total (a $0.7586 bill once showed as $0.79); the UI rounds
    // for display only.
    cost_usd: usd4(costCents),
    cost_cached_usd: usd4(cachedCostCents),
    billed_claude_code_tokens: billedClaudeCodeTokens,
    // Everything Anthropic metered that day, overlap included: the tokens cost_usd
    // actually paid for. Never summed into total (console_tokens + claude_code do that).
    anthropic_billed_tokens: billedTotal,
    codex_fidelity: codex ? ex.codex.fidelity || "exact" : "none",
    claude_code_fidelity: cc ? ex.claude_code.fidelity : "none",
    chat_fidelity: claudeChat + chatgpt > 0 ? "estimated" : "none",
    console_fidelity: consoleTokens ? "billed" : "none",
    openai_api_fidelity: openaiTokens ? "billed" : "none",
    local_model_fidelity: localTokens ? "exact" : "none",
    ...(Object.keys(localModels).length ? { local_model_models: localModels } : {}),
    // Claude subscription rate-limit meters, peak percent per local day (measured, not tokens).
    ...(pl ? { claude_plan_5h_pct: pl.five_hour_pct, claude_plan_7d_pct: pl.seven_day_pct } : {}),
    ...(oa?.models && Object.keys(oa.models).length ? { openai_api_models: oa.models } : {}),
    ...(ex?.codex?.models && Object.keys(ex.codex.models).length ? { codex_models: ex.codex.models } : {}),
    ...(ex?.claude_code?.models && Object.keys(ex.claude_code.models).length ? { claude_code_models: ex.claude_code.models } : {}),
    cost_fidelity: costCents ? "billed" : "none",
    ...(Object.keys(consoleModels).length ? { console_models: consoleModels } : {}),
  });
}

// One row per line: pretty-print, then fold each row's fields onto its line.
fs.writeFileSync(path.join(root, "data/daily-burn.json"), JSON.stringify(rows, null, 1).replace(/\n\s+"/g, ' "').replace(/\n\s*}/g, " }") + "\n");

/**
 * Freshness per lane, published beside the rows (data/burn-meta.json). The
 * dashboard flags a lane whose source has not been re-read recently, because a
 * stale lane looks exactly like a quiet one: the local logs once sat seven weeks
 * unrefreshed while the page looked current. Dates and timestamps only, so this
 * file passes the same deploy scrub as daily-burn.json.
 *   refreshedAt      when that source was last read (not when it last had usage)
 *   lastDataDay      newest day the lane has any tokens
 *   staleAfterHours  age at which the UI warns; manual exports get a longer leash
 */
const lastDay = (list, has) => list.filter(has).map((d) => d.date).sort().at(-1) || null;
const lanes = [
  {
    key: "local",
    label: "Local logs",
    detail: "Claude Code and Codex",
    kind: "auto",
    refreshedAt: exact.generatedAt || null,
    lastDataDay: lastDay(exact.days, (d) => (d.codex?.total || 0) + (d.claude_code?.total || 0) > 0),
    staleAfterHours: 48,
  },
];
if (console_?.configured) {
  lanes.push({
    key: "console",
    label: "Anthropic Console",
    detail: "billed tokens and cost",
    kind: "auto",
    refreshedAt: console_.generatedAt || null,
    lastDataDay: lastDay(console_.days, (d) => (d.usage_total || 0) > 0 || (d.cost?.cents || 0) > 0),
    staleAfterHours: 48,
  });
}
if (openai) {
  lanes.push({
    key: "openai",
    label: "OpenAI export",
    detail: "manual CSV import",
    kind: "manual",
    refreshedAt: openai.generatedAt || null,
    lastDataDay: lastDay(openai.days, (d) => (d.total || 0) > 0 || (d.cost_usd || 0) > 0),
    staleAfterHours: 24 * 35,
  });
}
if (ollama?.available) {
  lanes.push({
    key: "ollama",
    label: "Ollama logs",
    detail: "local models",
    kind: "auto",
    refreshedAt: ollama.generatedAt || null,
    lastDataDay: lastDay(ollama.days, (d) => (d.total || 0) > 0),
    staleAfterHours: 48,
  });
}
if (plan?.available) {
  lanes.push({
    key: "plan",
    label: "Claude plan meter",
    detail: "desktop app samples",
    kind: "auto",
    refreshedAt: plan.generatedAt || null,
    lastDataDay: lastDay(plan.days, () => true),
    staleAfterHours: 48,
  });
}
fs.writeFileSync(path.join(root, "data/burn-meta.json"), JSON.stringify({ builtAt: new Date().toISOString(), lanes }, null, 2) + "\n");

// ---------- Summary ----------
const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
const countBy = (k) => rows.reduce((acc, r) => ({ ...acc, [r[k]]: (acc[r[k]] || 0) + 1 }), {});
console.log(`Wrote data/daily-burn.json: ${rows.length} rows, ${rows[0]?.date} -> ${rows.at(-1)?.date}`);
console.log(`codex ${sum("codex_tokens").toLocaleString()} | claude_code ${sum("claude_code_tokens").toLocaleString()} | console ${sum("console_tokens").toLocaleString()} | openai_api ${sum("openai_api_tokens").toLocaleString()} | local_models ${sum("local_model_tokens").toLocaleString()} | claude_chat_est ${sum("claude_chat_est").toLocaleString()} | chatgpt_est ${sum("chatgpt_est").toLocaleString()} | total ${sum("total").toLocaleString()}`);
console.log("claude_code fidelity by day:", countBy("claude_code_fidelity"));
console.log("codex fidelity by day:", countBy("codex_fidelity"));
console.log("drivers:", [...new Set(rows.map((r) => r.driver))].join(", "));

if (openai) {
  console.log(`openai api: ${openai.days.length} billed day(s), ${sum("openai_api_tokens").toLocaleString()} tokens, $${sum("openai_api_usd").toFixed(4)} (UTC-day buckets from export)`);
} else {
  console.log("openai api: no export imported yet (run `npm run data:openai -- <folder>`); lane stays empty.");
}
if (!console_) {
  console.log("console: not pulled yet (run `npm run data:console`); billed and cost lanes stay empty.");
} else if (!console_.configured) {
  console.log(`console: not configured (${console_.reason}); billed and cost lanes stay empty.`);
} else {
  const costDays = rows.filter((r) => r.cost_usd > 0).length;
  console.log(
    `console: $${sum("cost_usd").toFixed(2)} across ${costDays} billed day(s), ` +
    `${sum("console_tokens").toLocaleString()} tokens with no local log` +
    (claudeCodeIsBilled ? `, ${sum("billed_claude_code_tokens").toLocaleString()} Claude Code tokens subtracted as overlap` : ", no Claude Code overlap (subscription-billed)"),
  );
  if (console_.warnings?.length) console.log(`console warnings: ${console_.warnings.join(" | ")}`);
}
