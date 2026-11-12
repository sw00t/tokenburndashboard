#!/usr/bin/env node
/**
 * extract-exact.mjs
 *
 * Reads local exact usage logs and writes data/private/exact-daily.json.
 * Nothing this script writes should be deployed. The private file keeps
 * per-source breakdowns and machine paths so numbers can be audited.
 *
 * Sources (in priority order):
 *   1. Codex CLI / Desktop session rollouts   (~/.codex/sessions, ~/.codex/archived_sessions)
 *   2. Claude Code CLI session logs           (~/.claude/projects/** /*.jsonl)
 *   3. Claude Cowork / local agent audit logs (~/Library/Application Support/Claude/local-agent-mode-sessions/** /audit.jsonl)
 *   4. Claude Code stats cache                (~/.claude/stats-cache.json) - used only for days
 *      whose session logs have been pruned. Its numbers double-count streamed
 *      lines and bucket by UTC, so they are scaled by a measured ratio and
 *      labeled "derived", never "exact".
 *
 * Day buckets use TZ below. "fresh" = input + cache_creation + output.
 * "cached" = cache_read. total = fresh + cached.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TZ = process.env.BURN_TZ
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || "UTC";
const HOME = os.homedir();
const OUT = path.resolve(process.cwd(), "data/private/exact-daily.json");

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const localDay = (iso) => dayFmt.format(new Date(iso));

function walk(dir, match, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, match, out);
    else if (match(p)) out.push(p);
  }
  return out;
}

function* jsonLines(file) {
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip partial line */ }
  }
}

const emptyBucket = () => ({ total: 0, fresh: 0, cached: 0, calls: 0, sessions: new Set(), models: {} });
const days = new Map();
function bucket(date, source) {
  if (!days.has(date)) days.set(date, { codex: emptyBucket(), cli: emptyBucket(), cowork: emptyBucket() });
  return days.get(date)[source];
}
function addUsage(b, { fresh, cached, session, model }) {
  b.fresh += fresh; b.cached += cached; b.total += fresh + cached; b.calls += 1;
  if (session) b.sessions.add(session);
  if (model) b.models[model] = (b.models[model] || 0) + fresh + cached;
}

// ---------- 1. Codex ----------
const codexFiles = [
  ...walk(path.join(HOME, ".codex/sessions"), (p) => p.endsWith(".jsonl")),
  ...walk(path.join(HOME, ".codex/archived_sessions"), (p) => p.endsWith(".jsonl")),
];
const codexSessionCheck = [];
for (const file of codexFiles) {
  let session = path.basename(file);
  // total_token_usage is a running counter per session; each token_count event is one
  // API call, so the delta between consecutive events is that call's usage.
  let summed = 0; let finalTotal = 0; let prevTotal = 0; let prevCached = 0;
  let model = "codex"; // turn_context carries the model in force for the token_count events that follow
  for (const r of jsonLines(file)) {
    if (r.type === "session_meta") session = r.payload?.id || session;
    if (r.type === "turn_context" && r.payload?.model) model = r.payload.model;
    if (r.type !== "event_msg" || r.payload?.type !== "token_count") continue;
    const total = r.payload.info?.total_token_usage;
    if (!total) continue;
    const t = (total.total_tokens || 0) - prevTotal;
    const cached = (total.cached_input_tokens || 0) - prevCached;
    prevTotal = total.total_tokens || 0; prevCached = total.cached_input_tokens || 0;
    finalTotal = prevTotal;
    if (t <= 0) continue;
    summed += t;
    addUsage(bucket(localDay(r.timestamp), "codex"), { fresh: t - cached, cached, session, model });
  }
  codexSessionCheck.push({ file, summedPerCall: summed, finalTotal, matches: summed === finalTotal });
}

// ---------- 2. Claude Code CLI ----------
const seenIds = new Set();
let cliNoDedupTotal = 0; let cliDedupTotal = 0;
const cliNoDedupUtcDay = new Map();
function ingestClaudeLine(r, source, ts) {
  if (r.type !== "assistant") return;
  const m = r.message; const u = m?.usage; const id = m?.id;
  if (!u || !id || !ts) return;
  const fresh = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  const cached = u.cache_read_input_tokens || 0;
  if (fresh + cached === 0) return; // API error placeholders carry zero usage
  if (source === "cli") {
    cliNoDedupTotal += fresh + cached;
    const utc = ts.slice(0, 10);
    cliNoDedupUtcDay.set(utc, (cliNoDedupUtcDay.get(utc) || 0) + fresh + cached);
  }
  if (seenIds.has(id)) return;
  seenIds.add(id);
  if (source === "cli") cliDedupTotal += fresh + cached;
  addUsage(bucket(localDay(ts), source), { fresh, cached, session: r.sessionId || r.session_id, model: m.model });
}
const cliFiles = walk(path.join(HOME, ".claude/projects"), (p) => p.endsWith(".jsonl"));
for (const file of cliFiles) for (const r of jsonLines(file)) ingestClaudeLine(r, "cli", r.timestamp);

// ---------- 3. Claude Cowork ----------
const coworkFiles = walk(
  path.join(HOME, "Library/Application Support/Claude/local-agent-mode-sessions"),
  (p) => path.basename(p) === "audit.jsonl",
);
for (const file of coworkFiles) for (const r of jsonLines(file)) ingestClaudeLine(r, "cowork", r._audit_timestamp || r.timestamp);

// ---------- 4. Stats cache (derived days only) ----------
const dedupRatio = cliNoDedupTotal ? cliDedupTotal / cliNoDedupTotal : 0.5;
let cliFreshShare = 0;
{
  let f = 0, t = 0;
  for (const d of days.values()) { f += d.cli.fresh; t += d.cli.total; }
  cliFreshShare = t ? f / t : 0.1;
}
const derived = [];
const statsPath = path.join(HOME, ".claude/stats-cache.json");
if (fs.existsSync(statsPath)) {
  const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
  const activity = new Map((stats.dailyActivity || []).map((a) => [a.date, a]));
  const cliDays = new Set([...days].filter(([, d]) => d.cli.calls > 0).map(([k]) => k));
  const prevDay = (d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
  const covered = (utcDate) => cliDays.has(utcDate) || cliDays.has(prevDay(utcDate));

  // calls-per-message ratio from days where both exist
  let callsSum = 0, msgSum = 0;
  for (const [date, d] of days) { const a = activity.get(date); if (a && d.cli.calls) { callsSum += d.cli.calls; msgSum += a.messageCount; } }
  const callsPerMessage = msgSum ? callsSum / msgSum : 0.2;

  const dailyTokens = stats.dailyModelTokens || [];
  let cachedDatesSum = 0;
  for (const e of dailyTokens) {
    const raw = Object.values(e.tokensByModel).reduce((s, v) => s + v, 0);
    cachedDatesSum += raw;
    if (covered(e.date)) continue;
    const total = Math.round(raw * dedupRatio);
    const a = activity.get(e.date);
    derived.push({ date: e.date, total, fresh: Math.round(total * cliFreshShare), cached: Math.round(total * (1 - cliFreshShare)),
      calls: a ? Math.round(a.messageCount * callsPerMessage) : 0, sessions: a?.sessionCount || 0,
      models: Object.fromEntries(Object.entries(e.tokensByModel).map(([k, v]) => [k, Math.round(v * dedupRatio)])),
      fidelity: "derived", note: `stats-cache day (UTC bucket) x dedup ratio ${dedupRatio.toFixed(3)}` });
  }

  // Days older than the per-day token cache: spread the remaining all-time total by message count.
  const allTime = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0), 0);
  const firstTokenDay = dailyTokens.map((e) => e.date).sort()[0] || "9999-12-31";
  const oldDays = (stats.dailyActivity || []).filter((a) => a.date < firstTokenDay && !covered(a.date) && a.messageCount > 0);
  const oldMsgs = oldDays.reduce((s, a) => s + a.messageCount, 0);
  const remainder = Math.max(0, allTime - cachedDatesSum);
  for (const a of oldDays) {
    const total = Math.round((remainder * (a.messageCount / oldMsgs)) * dedupRatio);
    derived.push({ date: a.date, total, fresh: Math.round(total * cliFreshShare), cached: Math.round(total * (1 - cliFreshShare)),
      calls: Math.round(a.messageCount * callsPerMessage), sessions: a.sessionCount, models: {},
      fidelity: "estimated", note: `pre-cache day: all-time remainder spread by message share (${a.messageCount} msgs) x dedup ratio` });
  }
  var statsMeta = { allTimeRaw: allTime, perDayCacheRaw: cachedDatesSum, remainderRaw: remainder, oldDayMessages: oldMsgs, callsPerMessage, lastComputedDate: stats.lastComputedDate };
}

// ---------- Assemble ----------
const finalize = (b) => ({ total: b.total, fresh: b.fresh, cached: b.cached, calls: b.calls, sessions: b.sessions.size, models: b.models });
const rows = [];
for (const [date, d] of days) {
  const cli = finalize(d.cli), cowork = finalize(d.cowork), codex = finalize(d.codex);
  const models = { ...cli.models };
  for (const [m, v] of Object.entries(cowork.models)) models[m] = (models[m] || 0) + v;
  rows.push({ date, codex, claude_code: {
    total: cli.total + cowork.total, fresh: cli.fresh + cowork.fresh, cached: cli.cached + cowork.cached,
    calls: cli.calls + cowork.calls, sessions: cli.sessions + cowork.sessions,
    fidelity: "exact", models, cli, cowork } });
}
for (const d of derived) {
  const existing = rows.find((r) => r.date === d.date);
  const cc = { total: d.total, fresh: d.fresh, cached: d.cached, calls: d.calls, sessions: d.sessions, fidelity: d.fidelity, note: d.note, models: d.models };
  if (existing) {
    // Cowork exact data exists on this day; add the derived CLI portion and downgrade the label.
    const e = existing.claude_code;
    e.total += cc.total; e.fresh += cc.fresh; e.cached += cc.cached; e.calls += cc.calls; e.sessions += cc.sessions;
    e.fidelity = d.fidelity; e.note = d.note; e.cliDerived = cc;
  } else {
    rows.push({ date: d.date, codex: finalize(emptyBucket()), claude_code: { ...cc, cli: null, cowork: null } });
  }
}
rows.sort((a, b) => a.date.localeCompare(b.date));

const out = {
  generatedAt: new Date().toISOString(), timezone: TZ,
  method: {
    fresh: "input_tokens + cache_creation_input_tokens + output_tokens",
    cached: "cache_read_input_tokens (Claude) / cached_input_tokens (Codex)",
    calls: "unique assistant message ids (Claude) / token_count events (Codex)",
    dedupRatio, cliFreshShare, stats: statsMeta || null,
  },
  sources: { codexFiles: codexFiles.length, cliFiles: cliFiles.length, coworkFiles: coworkFiles.length, codexSessionCheck },
  days: rows,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

// ---------- Summary ----------
const fmt = (n) => n.toLocaleString("en-US");
console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${rows.length} days, tz ${TZ})`);
console.log(`Codex files ${codexFiles.length} | Claude CLI files ${cliFiles.length} | Cowork files ${coworkFiles.length}`);
console.log(`CLI dedup ratio ${dedupRatio.toFixed(3)}  fresh share ${cliFreshShare.toFixed(3)}`);
console.log("date        codex      claude_code  (fresh/cached)            calls  fidelity");
for (const r of rows) {
  const c = r.claude_code;
  console.log(`${r.date}  ${fmt(r.codex.total).padStart(9)}  ${fmt(c.total).padStart(11)}  (${fmt(c.fresh)}/${fmt(c.cached)})`.padEnd(70) + `${String(c.calls + r.codex.calls).padStart(5)}  ${c.fidelity}`);
}
