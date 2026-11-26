#!/usr/bin/env node
/**
 * extract-exact.mjs
 *
 * Reads local usage logs and writes data/private/exact-daily.json.
 * Nothing this script writes should be deployed. The private file keeps
 * per-source breakdowns and machine paths so numbers can be audited.
 *
 * Sources:
 *   1. Codex CLI / Desktop session rollouts   (~/.codex/sessions, ~/.codex/archived_sessions)
 *   2. Claude Code CLI session logs           (~/.claude/projects/** /*.jsonl)
 *   3. Claude Cowork / local agent audit logs (~/Library/Application Support/Claude/local-agent-mode-sessions/** /audit.jsonl)
 *   4. Claude Code stats cache                (~/.claude/stats-cache.json), only for days whose
 *      session logs have been pruned. Its numbers double-count streamed lines
 *      and bucket by UTC, so they are scaled by a measured ratio and labeled
 *      "derived" (or "estimated" before the per-day cache begins), never "exact".
 *   5. Codex state database                   (~/.codex/state_5.sqlite), only for days with
 *      no Codex usage at all; labeled "derived" (see that section).
 *
 * Day buckets use TZ (lib/common.mjs). "fresh" = input + cache_creation + output.
 * "cached" = cache_read. total = fresh + cached.
 *
 * HISTORY IS MERGED, NOT REPLACED. The tools prune their own logs, so each run
 * merges with the previous output and never lets a day shrink because its logs
 * were deleted. `node scripts/extract-exact.mjs --rebuild` ignores history and
 * rebuilds from disk; only use it when every log you care about is still there.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { TZ, addDays, loadHistory, localDay, writeJsonAtomic } from "./lib/common.mjs";

const HOME = os.homedir();
const OUT = path.resolve(process.cwd(), "data/private/exact-daily.json");
const REBUILD = process.argv.includes("--rebuild");

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
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip partial line */ }
  }
}

// Per local day, one usage bucket for each local source.
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
/** A bucket as it is stored: plain numbers, session count instead of the Set. */
const finalize = (b) => ({ total: b.total, fresh: b.fresh, cached: b.cached, calls: b.calls, sessions: b.sessions.size, models: b.models });
const emptyCodexLane = () => finalize(emptyBucket());
const emptyClaudeLane = () => ({ ...finalize(emptyBucket()), fidelity: "exact" });

// ---------- 1. Codex ----------
const codexFiles = [
  ...walk(path.join(HOME, ".codex/sessions"), (p) => p.endsWith(".jsonl")),
  ...walk(path.join(HOME, ".codex/archived_sessions"), (p) => p.endsWith(".jsonl")),
];
const codexSessionCheck = [];
for (const file of codexFiles) {
  let session = path.basename(file);
  // Each token_count event carries last_token_usage (that one call) and
  // total_token_usage (a running counter). Use the per-call figure: the counter
  // resets when a session compacts its context, and a delta across the reset
  // drops the first call after it. An unchanged counter is a repeated event, not
  // a new call. Older logs without last_token_usage fall back to the delta.
  let summed = 0; let finalTotal = 0; let prevTotal = 0; let prevCached = 0;
  let model = "codex"; // turn_context carries the model in force for the token_count events that follow
  for (const r of jsonLines(file)) {
    if (r.type === "session_meta") session = r.payload?.id || session;
    if (r.type === "turn_context" && r.payload?.model) model = r.payload.model;
    if (r.type !== "event_msg" || r.payload?.type !== "token_count") continue;
    const total = r.payload.info?.total_token_usage;
    const last = r.payload.info?.last_token_usage;
    if (!total) continue;
    const runTotal = total.total_tokens || 0;
    if (runTotal === prevTotal) continue;
    const t = last ? last.total_tokens || 0 : runTotal - prevTotal;
    const cached = last ? last.cached_input_tokens || 0 : (total.cached_input_tokens || 0) - prevCached;
    prevTotal = runTotal; prevCached = total.cached_input_tokens || 0;
    finalTotal = prevTotal;
    if (t <= 0) continue;
    summed += t;
    addUsage(bucket(localDay(r.timestamp), "codex"), { fresh: t - cached, cached, session, model });
  }
  codexSessionCheck.push({ file, summedPerCall: summed, finalTotal, matches: summed === finalTotal });
}

// ---------- 2 + 3. Claude Code CLI and Cowork ----------
// The CLI writes one line per content block, so one API response (message id)
// repeats; the first line already carries its final usage. Ids are de-duplicated
// across both sources. The raw (repeated) CLI total is kept only to measure the
// de-duplication ratio applied to the stats cache below.
const seenIds = new Set();
let cliRawTotal = 0; let cliDedupTotal = 0;
function ingestClaudeLine(r, source, ts) {
  if (r.type !== "assistant") return;
  const m = r.message; const u = m?.usage; const id = m?.id;
  if (!u || !id || !ts) return;
  const fresh = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  const cached = u.cache_read_input_tokens || 0;
  if (fresh + cached === 0) return; // API error placeholders carry zero usage
  if (source === "cli") cliRawTotal += fresh + cached;
  if (seenIds.has(id)) return;
  seenIds.add(id);
  if (source === "cli") cliDedupTotal += fresh + cached;
  addUsage(bucket(localDay(ts), source), { fresh, cached, session: r.sessionId || r.session_id, model: m.model });
}
const cliFiles = walk(path.join(HOME, ".claude/projects"), (p) => p.endsWith(".jsonl"));
for (const file of cliFiles) for (const r of jsonLines(file)) ingestClaudeLine(r, "cli", r.timestamp);

const coworkFiles = walk(
  path.join(HOME, "Library/Application Support/Claude/local-agent-mode-sessions"),
  (p) => path.basename(p) === "audit.jsonl",
);
for (const file of coworkFiles) for (const r of jsonLines(file)) ingestClaudeLine(r, "cowork", r._audit_timestamp || r.timestamp);

// Prior output, merged in below. Loaded here because the stats-cache step needs
// to know which days history already holds as exact.
const previous = loadHistory(OUT); // null with --rebuild

// ---------- 4. Stats cache (derived days only) ----------
const dedupRatio = cliRawTotal ? cliDedupTotal / cliRawTotal : 0.5;
let cliFresh = 0; let cliTotal = 0;
for (const d of days.values()) { cliFresh += d.cli.fresh; cliTotal += d.cli.total; }
const cliFreshShare = cliTotal ? cliFresh / cliTotal : 0.1;
const splitFresh = (total) => ({ fresh: Math.round(total * cliFreshShare), cached: Math.round(total * (1 - cliFreshShare)) });

const derived = [];
let statsMeta = null;
const statsPath = path.join(HOME, ".claude/stats-cache.json");
if (fs.existsSync(statsPath)) {
  const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
  const activity = new Map((stats.dailyActivity || []).map((a) => [a.date, a]));
  // A stats-cache UTC day is "covered" when exact CLI logs exist for it or for the
  // local day before it (an LA evening lands on the next UTC day). Days whose CLI
  // logs have since been pruned still count as covered if the history holds them
  // as exact; otherwise their evening tokens would be derived a second time.
  const cliDays = new Set([...days].filter(([, d]) => d.cli.calls > 0).map(([k]) => k));
  for (const p of previous?.days || []) if (p.claude_code?.cli?.calls > 0) cliDays.add(p.date);
  const covered = (utcDate) => cliDays.has(utcDate) || cliDays.has(addDays(utcDate, -1));

  // Calls per stats-cache message, measured on days where both exist.
  let callsSum = 0; let msgSum = 0;
  for (const [date, d] of days) {
    const a = activity.get(date);
    if (a && d.cli.calls) { callsSum += d.cli.calls; msgSum += a.messageCount; }
  }
  const callsPerMessage = msgSum ? callsSum / msgSum : 0.2;

  const dailyTokens = stats.dailyModelTokens || [];
  let cachedDatesSum = 0;
  for (const e of dailyTokens) {
    const raw = Object.values(e.tokensByModel).reduce((s, v) => s + v, 0);
    cachedDatesSum += raw;
    if (covered(e.date)) continue;
    const total = Math.round(raw * dedupRatio);
    const a = activity.get(e.date);
    derived.push({ date: e.date, total, ...splitFresh(total),
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
    derived.push({ date: a.date, total, ...splitFresh(total),
      calls: Math.round(a.messageCount * callsPerMessage), sessions: a.sessionCount, models: {},
      fidelity: "estimated", note: `pre-cache day: all-time remainder spread by message share (${a.messageCount} msgs) x dedup ratio` });
  }
  statsMeta = { allTimeRaw: allTime, perDayCacheRaw: cachedDatesSum, remainderRaw: remainder, oldDayMessages: oldMsgs, callsPerMessage, lastComputedDate: stats.lastComputedDate };
}

// ---------- Assemble this run's scan ----------
const scanned = [];
for (const [date, d] of days) {
  const cli = finalize(d.cli), cowork = finalize(d.cowork), codex = finalize(d.codex);
  const models = { ...cli.models };
  for (const [m, v] of Object.entries(cowork.models)) models[m] = (models[m] || 0) + v;
  scanned.push({ date, codex, claude_code: {
    total: cli.total + cowork.total, fresh: cli.fresh + cowork.fresh, cached: cli.cached + cowork.cached,
    calls: cli.calls + cowork.calls, sessions: cli.sessions + cowork.sessions,
    fidelity: "exact", models, cli, cowork } });
}
for (const d of derived) {
  const existing = scanned.find((r) => r.date === d.date);
  const cc = { total: d.total, fresh: d.fresh, cached: d.cached, calls: d.calls, sessions: d.sessions, fidelity: d.fidelity, note: d.note, models: d.models };
  if (existing) {
    // Cowork exact data exists on this day; add the derived CLI portion and downgrade the label.
    const e = existing.claude_code;
    e.total += cc.total; e.fresh += cc.fresh; e.cached += cc.cached; e.calls += cc.calls; e.sessions += cc.sessions;
    e.fidelity = d.fidelity; e.note = d.note; e.cliDerived = cc;
  } else {
    scanned.push({ date: d.date, codex: emptyCodexLane(), claude_code: { ...cc, cli: null, cowork: null } });
  }
}

// ---------- Merge with prior history ----------
/**
 * The tools prune their own logs (Claude Code after cleanupPeriodDays, Codex and
 * Cowork on their own schedules), so a fresh scan cannot see days it saw before.
 * Rebuilding from disk alone would silently erase history. Instead each lane of
 * each day is merged with the previous output:
 *   - better fidelity wins (exact > derived > estimated)
 *   - two exact readings: the larger wins, because logs only lose content to
 *     pruning; a smaller re-read means files went missing, not that usage fell
 *   - two derived/estimated readings: the stored figure is kept, so history does
 *     not drift as the correction ratio is re-measured on newer logs
 * Lanes taken from history carry `preservedFrom`, the run that last read them
 * from disk.
 */
const FIDELITY_RANK = { exact: 3, derived: 2, estimated: 1 };
const laneRank = (lane) => (lane && lane.total > 0 ? FIDELITY_RANK[lane.fidelity || "exact"] || 3 : 0);
function pickLane(prev, next) {
  const rp = laneRank(prev);
  const rn = laneRank(next);
  const usePrev = rp > rn || (rp === rn && rp > 0 && (rp < 3 || prev.total > next.total));
  if (!usePrev) return { lane: next, preserved: false };
  const changed = !next || prev.total !== next.total;
  return {
    lane: changed ? { ...prev, preservedFrom: prev.preservedFrom || previous.generatedAt } : prev,
    preserved: changed,
  };
}

const prevByDate = new Map((previous?.days || []).map((r) => [r.date, r]));
const scannedByDate = new Map(scanned.map((r) => [r.date, r]));
const preservedDays = new Set();
const rows = [];
for (const date of [...new Set([...prevByDate.keys(), ...scannedByDate.keys()])].sort()) {
  const p = prevByDate.get(date);
  const n = scannedByDate.get(date);
  const codex = pickLane(p?.codex, n?.codex || emptyCodexLane());
  const claude = pickLane(p?.claude_code, n?.claude_code || emptyClaudeLane());
  if (codex.preserved || claude.preserved) preservedDays.add(date);
  rows.push({ date, codex: codex.lane, claude_code: claude.lane });
}

// ---------- 5. Codex state database (derived, only for days with no Codex usage) ----------
/**
 * Codex prunes its session rollouts, but ~/.codex/state_5.sqlite keeps one row
 * per session (thread) with its model and running token counter. For local days
 * where neither the logs on disk nor history have any Codex usage, that table is
 * the only record left, so it fills them, labeled "derived". It is a lower
 * bound: the counter resets when a session compacts its context (one session
 * logged 13.4M while the table kept 375K), and each session's whole total lands
 * on the day it started. Days with Codex usage are never touched, and once
 * filled a day is frozen by the history merge like any other.
 */
function readCodexThreadsByDay() {
  const db = path.join(HOME, ".codex/state_5.sqlite");
  if (!fs.existsSync(db)) return null;
  let text = "";
  try {
    // immutable=1 reads without taking locks while Codex is running. It skips
    // un-checkpointed WAL pages, which only affects the newest sessions, and
    // those still have rollout logs on disk.
    text = execFileSync(
      "/usr/bin/sqlite3",
      ["-readonly", "-separator", "\t", `file:${db}?mode=ro&immutable=1`,
        "select created_at, model, tokens_used from threads where tokens_used > 0"],
      { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    console.log("Codex state database unreadable; days without Codex logs stay empty.");
  }
  const byDay = new Map();
  for (const line of text.trim().split("\n")) {
    const [createdAt, model, tokens] = line.split("\t");
    const total = Number(tokens);
    if (!createdAt || !Number.isFinite(total) || total <= 0) continue;
    const date = localDay(Number(createdAt) * 1000);
    const d = byDay.get(date) || { total: 0, sessions: 0, models: {} };
    d.total += total; d.sessions += 1;
    const key = model || "codex";
    d.models[key] = (d.models[key] || 0) + total;
    byDay.set(date, d);
  }
  return byDay;
}

let codexDbDays = 0;
let codexDbTokens = 0;
const threadsByDay = readCodexThreadsByDay();
if (threadsByDay) {
  // Split derived totals into fresh/cached with the share measured on exact Codex days.
  let exactFresh = 0; let exactTotal = 0;
  for (const r of rows) {
    if ((r.codex.fidelity || "exact") === "exact") { exactFresh += r.codex.fresh || 0; exactTotal += r.codex.total || 0; }
  }
  const codexFreshShare = exactTotal ? exactFresh / exactTotal : 0.1;
  const rowByDate = new Map(rows.map((r) => [r.date, r]));
  for (const [date, d] of threadsByDay) {
    const existing = rowByDate.get(date);
    if (existing && existing.codex.total > 0) continue;
    const fresh = Math.round(d.total * codexFreshShare);
    const lane = {
      total: d.total, fresh, cached: d.total - fresh, calls: 0, sessions: d.sessions, models: d.models,
      fidelity: "derived",
      note: `Codex state database: ${d.sessions} session total(s) on their start day; lower bound (compaction resets the counter)`,
    };
    if (existing) existing.codex = lane;
    else rows.push({ date, codex: lane, claude_code: emptyClaudeLane() });
    codexDbDays += 1;
    codexDbTokens += d.total;
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
}

writeJsonAtomic(OUT, {
  generatedAt: new Date().toISOString(), timezone: TZ,
  method: {
    fresh: "input_tokens + cache_creation_input_tokens + output_tokens",
    cached: "cache_read_input_tokens (Claude) / cached_input_tokens (Codex)",
    calls: "unique assistant message ids (Claude) / token_count events (Codex)",
    merge: REBUILD
      ? "rebuilt from logs on disk; prior history ignored (--rebuild)"
      : "merged with prior output per day and lane: better fidelity wins, larger exact reading wins, stored derived/estimated figures are kept",
    dedupRatio, cliFreshShare, stats: statsMeta,
  },
  sources: {
    codexFiles: codexFiles.length, cliFiles: cliFiles.length, coworkFiles: coworkFiles.length, codexSessionCheck,
    scannedDays: scanned.length, preservedDays: preservedDays.size,
  },
  days: rows,
});

// ---------- Summary ----------
const fmt = (n) => n.toLocaleString("en-US");
console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${rows.length} days, tz ${TZ})`);
console.log(`Codex files ${codexFiles.length} | Claude CLI files ${cliFiles.length} | Cowork files ${coworkFiles.length}`);
console.log(`CLI dedup ratio ${dedupRatio.toFixed(3)}  fresh share ${cliFreshShare.toFixed(3)}`);
console.log(REBUILD
  ? "History: ignored (--rebuild); every day below comes from logs on disk now."
  : `History: ${scanned.length} day(s) read from disk, ${preservedDays.size} day(s) kept from earlier runs because their logs are gone or shrank (marked *).`);
if (codexDbDays) console.log(`Codex state database: filled ${codexDbDays} day(s) with no Codex logs, ${fmt(codexDbTokens)} tokens (derived, lower bound).`);
console.log("date        codex      claude_code  (fresh/cached)            calls  fidelity");
for (const r of rows) {
  const c = r.claude_code;
  const mark = preservedDays.has(r.date) ? " *" : "";
  console.log(`${r.date}  ${fmt(r.codex.total).padStart(9)}  ${fmt(c.total).padStart(11)}  (${fmt(c.fresh)}/${fmt(c.cached)})`.padEnd(70) + `${String(c.calls + r.codex.calls).padStart(5)}  ${c.fidelity}${mark}`);
}
