#!/usr/bin/env node
/**
 * fetch-console.mjs
 *
 * Pulls Anthropic Console billing telemetry into data/private/console-daily.json.
 * This is the "billed" fidelity tier: Anthropic's own meter, not our local logs.
 *
 * Endpoints (Usage & Cost Admin API):
 *   GET /v1/organizations/usage_report/messages    <- platform.claude.com/usage + /usage/cache
 *   GET /v1/organizations/cost_report              <- platform.claude.com/cost
 *   GET /v1/organizations/usage_report/claude_code <- per-user Claude Code analytics
 *
 * CREDENTIALS
 *   Never stored in this repo, never printed, never returned to the browser.
 *   Resolution order:
 *     1. ANTHROPIC_ADMIN_KEY in the environment (one-off runs)
 *     2. macOS Keychain, service "token-burn-console"
 *   Store it once with (note the bare -w last, so it prompts and never
 *   reaches your shell history):
 *
 *     security add-generic-password -U -a "$USER" -s token-burn-console -w
 *
 *   The item is created by /usr/bin/security and read back by /usr/bin/security,
 *   so macOS trusts the read without an extra prompt. Generic passwords added
 *   this way are not iCloud-synchronised.
 *
 * TIME BUCKETS
 *   The API buckets in UTC; this dashboard buckets in BURN_TZ. Token usage is
 *   therefore fetched at 1h granularity and re-bucketed into local days, so it
 *   lines up with the local-log columns. The cost endpoint only offers 1d, so
 *   cost stays on UTC day boundaries and is labelled as such.
 *
 * USAGE
 *   node scripts/fetch-console.mjs --check         # probe permissions, fetch nothing
 *   node scripts/fetch-console.mjs                 # incremental: last 14 days
 *   node scripts/fetch-console.mjs --days 45       # re-pull a longer tail
 *   node scripts/fetch-console.mjs --since 2026-02-01
 *   node scripts/fetch-console.mjs --full          # everything since --since or 180d
 *   node scripts/fetch-console.mjs --no-claude-code
 *
 * Exits 0 with a "not configured" marker when no credential is present, so
 * `npm run data` still works on a machine that has never set this up.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TZ = process.env.BURN_TZ
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || "UTC";
const OUT = path.resolve(process.cwd(), "data/private/console-daily.json");
const PROGRESS = path.resolve(process.cwd(), "data/private/console-progress.json");
const BASE = "https://api.anthropic.com/v1/organizations";
const KEYCHAIN_SERVICE = process.env.BURN_KEYCHAIN_SERVICE || "token-burn-console";
const USER_AGENT = "token-burn-dashboard/1.0 (local)";

// The endpoint supports ~1 request/minute sustained; bursts are fine for
// paginating a backfill. This keeps a long backfill polite without crawling.
const REQUEST_GAP_MS = Number(process.env.BURN_REQUEST_GAP_MS || 900);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const localDay = (iso) => dayFmt.format(new Date(iso));
const utcDay = (iso) => iso.slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- credentials

/**
 * Classifies a credential by prefix only. Never returns or logs the secret.
 *   admin-key   sk-ant-admin...  provisioned at Console > Settings > Admin keys
 *   plain-key   sk-ant-api...    a normal key; its permissions are the linked
 *                                account's org role, which is the usual cause
 *                                of a 403 on the usage and cost endpoints
 *   oauth       anything else, sent as a bearer token
 */
function credentialKind(secret) {
  if (secret.startsWith("sk-ant-admin")) return "admin-key";
  if (secret.startsWith("sk-ant-")) return "plain-key";
  return "oauth";
}

/** Returns { header, kind, sourceLabel } or null. The secret never leaves this scope. */
function resolveCredential() {
  const env = process.env.ANTHROPIC_ADMIN_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (env && env.trim()) {
    const secret = env.trim();
    const isOauth = !!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_ADMIN_KEY;
    return {
      header: isOauth ? { authorization: `Bearer ${secret}` } : { "x-api-key": secret },
      kind: isOauth ? "oauth" : credentialKind(secret),
      sourceLabel: isOauth ? "env:ANTHROPIC_AUTH_TOKEN" : "env:ANTHROPIC_ADMIN_KEY",
    };
  }
  if (process.platform !== "darwin") return null;
  try {
    const secret = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!secret) return null;
    const kind = credentialKind(secret);
    const header = kind === "oauth"
      ? { authorization: `Bearer ${secret}` }
      : { "x-api-key": secret };
    return { header, kind, sourceLabel: `keychain:${KEYCHAIN_SERVICE}` };
  } catch {
    return null; // item missing, or the user denied the access prompt
  }
}

/** Human-readable name for the credential class, safe to print and to ship to the UI. */
const KIND_LABEL = {
  "admin-key": "Admin API key (sk-ant-admin…)",
  "plain-key": "regular API key (sk-ant-api…)",
  oauth: "OAuth bearer token",
};

/**
 * What a 401/403 means for this credential class, and the shortest way out.
 * A 403 is the interesting case: the credential is valid, it simply is not
 * permitted to read organization usage and cost.
 */
function authGuidance(status, kind) {
  if (status === 401) {
    return kind === "oauth"
      ? "The OAuth token was rejected — these are short-lived. Re-run `ant auth login --profile admin --scope \"org:admin\"` and export a fresh token."
      : "The key was rejected outright. Confirm it was copied whole and has not been revoked or expired.";
  }
  if (kind === "plain-key") {
    return (
      "This is a regular API key, not an Admin key. An organization-scoped regular key authenticates fine, but it " +
      "carries exactly the org role of the account that owns it. Two causes, and the probe above tells them apart:\n" +
      "  (a) 'organization info' ALSO 403s -> there is most likely no Console organization on this account. The " +
      "Admin API does not exist for individual accounts, which is also why Settings > Admin keys 404s. Create one at " +
      "https://platform.claude.com/settings/organization, then the Admin keys page appears.\n" +
      "  (b) 'organization info' succeeds but usage/cost 403 -> an org exists, but your role is not admin. Ask an org " +
      "admin to raise your role or to create the key.\n" +
      "Either way the goal is an Admin API key (sk-ant-admin01-) from https://platform.claude.com/settings/admin-keys."
    );
  }
  if (kind === "oauth") {
    return "The token authenticated but lacks the org:admin scope. Re-login with `ant auth login --profile admin --scope \"org:admin\"`.";
  }
  return (
    "The Admin key authenticated but is not permitted on these endpoints. Two known causes: (1) this is a Claude " +
    "Enterprise (claude.ai) organization, which uses a separate Analytics API key created at claude.ai > Organization " +
    "settings > API, not an Admin key; (2) the organization has not been granted Usage & Cost API access. " +
    "If neither applies, contact Anthropic support with the request_id below."
  );
}

function notConfigured(reason) {
  const payload = {
    configured: false,
    reason,
    generatedAt: new Date().toISOString(),
    timezone: TZ,
    keychainService: KEYCHAIN_SERVICE,
    setupHint: `security add-generic-password -U -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
    days: [],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`Console sync not configured (${reason}).`);
  console.log(`Store an Admin API key, then re-run:\n  ${payload.setupHint}`);
  process.exit(0);
}

// ---------------------------------------------------------------- progress

/**
 * A small file the API route reads so the dashboard can show a real progress
 * bar instead of an indeterminate spinner. Written on every request; removed
 * when the run ends. Contains no credential material.
 */
const progress = { running: false, phase: "starting", done: 0, total: 0, startedAt: null };

function writeProgress(patch = {}) {
  Object.assign(progress, patch);
  try {
    fs.mkdirSync(path.dirname(PROGRESS), { recursive: true });
    fs.writeFileSync(PROGRESS, JSON.stringify({
      ...progress,
      pct: progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0,
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    /* progress is best-effort; never fail a pull over it */
  }
}

function clearProgress() {
  try { fs.rmSync(PROGRESS, { force: true }); } catch { /* ignore */ }
}

// A killed run must not leave the dashboard showing a pull that is not happening.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { clearProgress(); process.exit(130); });
}

/** Requests a run will make, so the bar has a denominator before it starts. */
function planRequests(from, to, withClaudeCode) {
  const days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
  return Math.ceil(days / 7) + Math.ceil(days / 31) + (withClaudeCode ? days : 0);
}

// ---------------------------------------------------------------- http

/** No single request may stall the run. */
const REQUEST_TIMEOUT_MS = Number(process.env.BURN_REQUEST_TIMEOUT_MS || 60_000);
/** Longest we will sit inside a retry before giving the caller their turn back. */
const MAX_BACKOFF_MS = Number(process.env.BURN_MAX_BACKOFF_MS || 60_000);

let requestCount = 0;

/**
 * Sleep through a retry while keeping the progress file alive, so the dashboard
 * shows "rate limited, retrying in 12s" instead of a bar frozen at the same
 * percentage with no explanation.
 */
async function backoff(totalMs, reason) {
  const until = Date.now() + totalMs;
  const basePhase = progress.phase;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) break;
    if (progress.running) {
      writeProgress({ phase: `${basePhase} — ${reason}, retrying in ${Math.ceil(left / 1000)}s` });
    }
    await sleep(Math.min(1000, left));
  }
  if (progress.running) writeProgress({ phase: basePhase });
}

async function apiGet(pathname, params, cred) {
  const qs = new URLSearchParams();
  for (const [k, v] of params) if (v !== undefined && v !== null) qs.append(k, String(v));
  const url = `${BASE}${pathname}?${qs}`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (requestCount > 0) await sleep(REQUEST_GAP_MS);
    requestCount += 1;
    if (progress.running) writeProgress({ done: requestCount });

    // Without a deadline a stalled socket hangs the whole run: the progress bar
    // freezes, the API route sits on its 15 minute timeout, and nothing says why.
    let res;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(url, {
        headers: { "anthropic-version": "2023-06-01", "user-agent": USER_AGENT, ...cred.header },
        signal: abort.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const timedOut = error.name === "AbortError";
      if (attempt < 4) {
        const wait = 2 ** attempt * 1000;
        const why = timedOut ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : error.message;
        console.log(`  ${pathname} ${why}; retrying in ${wait / 1000}s`);
        await backoff(wait, timedOut ? "request timed out" : "network error");
        continue;
      }
      throw new Error(`${pathname} ${timedOut ? "timed out" : "failed"}: ${error.message}`);
    }
    clearTimeout(timer);
    if (res.ok) return res.json();

    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      // Do not retry an auth failure. 401 = credential rejected; 403 = credential
      // is valid but not permitted here. They have different fixes.
      const requestId = res.headers.get("request-id") || safeJson(body)?.request_id || "";
      const error = new Error(
        `${res.status} on ${pathname} using a ${KIND_LABEL[cred.kind]}.\n\n${authGuidance(res.status, cred.kind)}` +
          (requestId ? `\n\nrequest_id: ${requestId}` : ""),
      );
      error.authProblem = {
        status: res.status,
        kind: cred.kind,
        kindLabel: KIND_LABEL[cred.kind],
        guidance: authGuidance(res.status, cred.kind),
        requestId,
      };
      throw error;
    }
    const hinted = Number(res.headers.get("retry-after")) * 1000;

    // A retry-after longer than we are willing to sit on is not worth retrying:
    // four doomed attempts just delay the same failure. Stop and say when the
    // window reopens, so the caller can come back rather than watch a dead bar.
    if (res.status === 429 && Number.isFinite(hinted) && hinted > MAX_BACKOFF_MS) {
      const readyAt = new Date(Date.now() + hinted);
      const mins = Math.ceil(hinted / 60_000);
      const error = new Error(
        `Rate limited on ${pathname}. The server asked for ${Math.round(hinted / 1000)}s ` +
          `(~${mins} min), longer than this script will wait. Nothing was lost — cached days are kept. ` +
          `Try again after ${readyAt.toLocaleTimeString()}.`,
      );
      error.rateLimited = { retryAfterMs: hinted, readyAt: readyAt.toISOString() };
      throw error;
    }

    if ([429, 500, 502, 503, 529].includes(res.status) && attempt < 4) {
      const wait = Math.min(
        Number.isFinite(hinted) && hinted > 0 ? hinted : 2 ** attempt * 1000,
        MAX_BACKOFF_MS,
      );
      console.log(`  ${res.status} on ${pathname}; retrying in ${Math.round(wait / 1000)}s`);
      await backoff(wait, res.status === 429 ? "rate limited" : `server ${res.status}`);
      continue;
    }
    throw new Error(`${res.status} from ${pathname}: ${body.slice(0, 300)}`);
  }
  throw new Error(`${pathname} failed after retries`);
}

async function* pages(pathname, params, cred) {
  let page = null;
  for (;;) {
    const p = page ? [...params, ["page", page]] : params;
    const body = await apiGet(pathname, p, cred);
    yield body;
    if (!body.has_more || !body.next_page) return;
    page = body.next_page;
  }
}

// ---------------------------------------------------------------- accumulator

const emptyUsage = () => ({
  uncached_input: 0, cache_read: 0, cache_creation_5m: 0, cache_creation_1h: 0,
  output: 0, web_search_requests: 0, models: {},
});
const emptyCost = () => ({ cents: 0, byCostType: {}, byTokenType: {} });
const usageTotal = (u) =>
  u.uncached_input + u.cache_read + u.cache_creation_5m + u.cache_creation_1h + u.output;

/**
 * The provider reports on three different clocks:
 *   usage   1h buckets  -> can be attributed to either clock
 *   cost    1d UTC only
 *   claude code analytics  1d UTC only
 * The dashboard's rows are LOCAL days. Joining a UTC-day figure onto a local-day
 * row silently misfiles roughly a third of a day's work (7-8h of offset), which
 * breaks both the overlap subtraction and any reconciliation.
 *
 * So we keep the hourly token counts split by (UTC day -> local day) and use
 * that measured distribution to apportion each UTC-day cost and Claude Code
 * total across the local days it actually spans. Window totals are preserved
 * exactly; only the per-day attribution is derived.
 */
const split = new Map(); // utcDay -> localDay -> usage bucket
function splitBucket(utc, local) {
  if (!split.has(utc)) split.set(utc, new Map());
  const inner = split.get(utc);
  if (!inner.has(local)) inner.set(local, emptyUsage());
  return inner.get(local);
}

const costUtc = new Map();       // utcDay -> cost
const ccUtc = new Map();         // utcDay -> claude code aggregate

/** Token-type keys as the cost report names them, mapped to our usage fields. */
const TOKEN_TYPE_FIELD = {
  uncached_input_tokens: "uncached_input",
  cache_read_input_tokens: "cache_read",
  "cache_creation.ephemeral_5m_input_tokens": "cache_creation_5m",
  "cache_creation.ephemeral_1h_input_tokens": "cache_creation_1h",
  output_tokens: "output",
};

// ---------------------------------------------------------------- fetchers

/**
 * Token usage at 1h granularity, re-bucketed into local days.
 * 1h allows at most 168 buckets (7 days) per request.
 */
async function fetchUsage(from, to, cred) {
  writeProgress({ phase: "token usage" });
  let cursor = from;
  while (cursor < to) {
    const chunkEnd = [addDays(cursor, 7), to].sort()[0];
    process.stdout.write(`  usage  ${cursor} -> ${chunkEnd}\n`);
    const params = [
      ["starting_at", `${cursor}T00:00:00Z`],
      ["ending_at", `${chunkEnd}T00:00:00Z`],
      ["bucket_width", "1h"],
      ["limit", "168"],
      ["group_by[]", "model"],
    ];
    for await (const body of pages("/usage_report/messages", params, cred)) {
      for (const bucket of body.data || []) {
        // One hour belongs to exactly one UTC day and one local day; recording
        // the pair is what makes apportionment possible later.
        const target = splitBucket(utcDay(bucket.starting_at), localDay(bucket.starting_at));
        for (const row of bucket.results || []) {
          const cc = row.cache_creation || {};
          target.uncached_input += row.uncached_input_tokens || 0;
          target.cache_read += row.cache_read_input_tokens || 0;
          target.cache_creation_5m += cc.ephemeral_5m_input_tokens || 0;
          target.cache_creation_1h += cc.ephemeral_1h_input_tokens || 0;
          target.output += row.output_tokens || 0;
          target.web_search_requests += (row.server_tool_use || {}).web_search_requests || 0;
          if (row.model) {
            const t = (row.uncached_input_tokens || 0) + (row.cache_read_input_tokens || 0)
              + (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0)
              + (row.output_tokens || 0);
            target.models[row.model] = (target.models[row.model] || 0) + t;
          }
        }
      }
    }
    cursor = chunkEnd;
  }
}

/**
 * Cost in USD cents, per UTC day. Held on the UTC clock here and apportioned to
 * local days in assemble(). cost_type and token_type are closed enums, which is
 * why they are safe to carry into the public file; free-text `description` and
 * `workspace_id` are deliberately dropped here and never reach the merge step.
 */
async function fetchCost(from, to, cred) {
  writeProgress({ phase: "cost" });
  let cursor = from;
  while (cursor < to) {
    const chunkEnd = [addDays(cursor, 31), to].sort()[0];
    process.stdout.write(`  cost   ${cursor} -> ${chunkEnd}\n`);
    const params = [
      ["starting_at", `${cursor}T00:00:00Z`],
      ["ending_at", `${chunkEnd}T00:00:00Z`],
      ["bucket_width", "1d"],
      ["limit", "31"],
      ["group_by[]", "description"],
    ];
    for await (const body of pages("/cost_report", params, cred)) {
      for (const bucket of body.data || []) {
        const key = utcDay(bucket.starting_at);
        if (!costUtc.has(key)) costUtc.set(key, emptyCost());
        const target = costUtc.get(key);
        for (const row of bucket.results || []) {
          const cents = Number.parseFloat(row.amount || "0");
          if (!Number.isFinite(cents)) continue;
          target.cents += cents;
          const ct = row.cost_type || "unclassified";
          target.byCostType[ct] = (target.byCostType[ct] || 0) + cents;
          if (row.token_type) {
            target.byTokenType[row.token_type] = (target.byTokenType[row.token_type] || 0) + cents;
          }
        }
      }
    }
    cursor = chunkEnd;
  }
}

/**
 * Claude Code analytics: one UTC day per request, per-user rows.
 * Only aggregates are kept. Email addresses and API key names are read to count
 * distinct actors and are never written anywhere.
 */
async function fetchClaudeCode(from, to, cred) {
  writeProgress({ phase: "Claude Code analytics" });
  const customerTypes = new Set();
  let date = from;
  let fetched = 0;
  while (date < to) {
    const agg = {
      input: 0, output: 0, cache_read: 0, cache_creation: 0,
      cost_cents: 0, sessions: 0, actors: 0, lines_added: 0, lines_removed: 0,
      models: {},
    };
    const actors = new Set();
    let sawAny = false;
    for await (const body of pages("/usage_report/claude_code", [["starting_at", date], ["limit", "1000"]], cred)) {
      for (const rec of body.data || []) {
        sawAny = true;
        const actor = rec.actor || {};
        const id = actor.email_address || actor.api_key_name;
        if (id) actors.add(id); // counted only; never persisted
        if (rec.customer_type) customerTypes.add(rec.customer_type);
        const core = rec.core_metrics || {};
        agg.sessions += core.num_sessions || 0;
        agg.lines_added += (core.lines_of_code || {}).added || 0;
        agg.lines_removed += (core.lines_of_code || {}).removed || 0;
        for (const mb of rec.model_breakdown || []) {
          const t = mb.tokens || {};
          agg.input += t.input || 0;
          agg.output += t.output || 0;
          agg.cache_read += t.cache_read || 0;
          agg.cache_creation += t.cache_creation || 0;
          agg.cost_cents += (mb.estimated_cost || {}).amount || 0;
          if (mb.model) {
            const sum = (t.input || 0) + (t.output || 0) + (t.cache_read || 0) + (t.cache_creation || 0);
            agg.models[mb.model] = (agg.models[mb.model] || 0) + sum;
          }
        }
      }
    }
    if (sawAny) {
      agg.actors = actors.size;
      ccUtc.set(date, agg);
      fetched += 1;
    }
    date = addDays(date, 1);
  }
  process.stdout.write(`  claude code: ${fetched} day(s) with activity\n`);
  return [...customerTypes];
}

// ---------------------------------------------------------------- assemble

/**
 * Fold the UTC-clock figures (cost, Claude Code) onto local-day rows using the
 * measured hourly token distribution.
 *
 * Cost is apportioned per token type, so a local day that took the cache-read
 * heavy half of a UTC day is charged at cache-read rates rather than at the
 * day's blended rate. Cost rows with no token type (web search, code execution,
 * session usage) fall back to the total-token share.
 *
 * Window totals are preserved exactly - every UTC day's cents and Claude Code
 * tokens are fully distributed, never dropped or duplicated.
 */
function assemble() {
  const local = new Map();
  const row = (date) => {
    if (!local.has(date)) {
      local.set(date, {
        date,
        usage: emptyUsage(),
        cost: emptyCost(),
        claude_code: null,
        /** UTC days this local day draws from, for auditing against the Console pages. */
        from_utc_days: [],
      });
    }
    return local.get(date);
  };

  for (const [utc, byLocal] of split) {
    // Shares of this UTC day's tokens, per type, by local day.
    const dayTotals = emptyUsage();
    for (const u of byLocal.values()) {
      for (const k of Object.keys(dayTotals)) {
        if (typeof dayTotals[k] === "number") dayTotals[k] += u[k];
      }
    }
    const dayTotalTokens = usageTotal(dayTotals);
    const cost = costUtc.get(utc);
    const cc = ccUtc.get(utc);

    for (const [localDate, u] of byLocal) {
      const r = row(localDate);
      for (const k of Object.keys(r.usage)) {
        if (typeof r.usage[k] === "number") r.usage[k] += u[k];
      }
      for (const [m, v] of Object.entries(u.models)) r.usage.models[m] = (r.usage.models[m] || 0) + v;
      if (!r.from_utc_days.includes(utc)) r.from_utc_days.push(utc);

      const totalShare = dayTotalTokens ? usageTotal(u) / dayTotalTokens : 0;

      if (cost) {
        for (const [tokenType, cents] of Object.entries(cost.byTokenType)) {
          const field = TOKEN_TYPE_FIELD[tokenType];
          const share = field && dayTotals[field] ? u[field] / dayTotals[field] : totalShare;
          const part = cents * share;
          r.cost.cents += part;
          r.cost.byTokenType[tokenType] = (r.cost.byTokenType[tokenType] || 0) + part;
        }
        // Non-token costs, and any residue if byTokenType does not cover the total.
        const typed = Object.values(cost.byTokenType).reduce((s, v) => s + v, 0);
        const untyped = cost.cents - typed;
        if (Math.abs(untyped) > 1e-9) r.cost.cents += untyped * totalShare;
        for (const [ct, cents] of Object.entries(cost.byCostType)) {
          r.cost.byCostType[ct] = (r.cost.byCostType[ct] || 0) + cents * totalShare;
        }
      }

      if (cc && totalShare > 0) {
        const scale = (n) => (n || 0) * totalShare;
        r.claude_code = r.claude_code || {
          input: 0, output: 0, cache_read: 0, cache_creation: 0,
          cost_cents: 0, sessions: 0, actors: 0, lines_added: 0, lines_removed: 0, models: {},
          apportioned: true,
        };
        r.claude_code.input += scale(cc.input);
        r.claude_code.output += scale(cc.output);
        r.claude_code.cache_read += scale(cc.cache_read);
        r.claude_code.cache_creation += scale(cc.cache_creation);
        r.claude_code.cost_cents += scale(cc.cost_cents);
        r.claude_code.sessions += scale(cc.sessions);
        r.claude_code.lines_added += scale(cc.lines_added);
        r.claude_code.lines_removed += scale(cc.lines_removed);
        r.claude_code.actors = Math.max(r.claude_code.actors, cc.actors || 0);
      }
    }
  }

  // A UTC day with cost but no token usage has no distribution to follow; keep it
  // on its own date rather than discarding real money.
  for (const [utc, cost] of costUtc) {
    if (split.has(utc) || cost.cents === 0) continue;
    const r = row(utc);
    r.cost.cents += cost.cents;
    for (const [k, v] of Object.entries(cost.byTokenType)) r.cost.byTokenType[k] = (r.cost.byTokenType[k] || 0) + v;
    for (const [k, v] of Object.entries(cost.byCostType)) r.cost.byCostType[k] = (r.cost.byCostType[k] || 0) + v;
    r.unapportioned_cost = true;
  }

  return [...local.values()]
    .map((d) => ({
      ...d,
      usage_total: usageTotal(d.usage),
      claude_code: d.claude_code
        ? Object.fromEntries(Object.entries(d.claude_code).map(([k, v]) =>
            [k, typeof v === "number" ? Math.round(v) : v]))
        : null,
    }))
    .filter((d) => d.usage_total > 0 || d.cost.cents > 0 || d.claude_code)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------- main

async function main() {
  const cred = resolveCredential();
  if (!cred) {
    notConfigured(
      process.platform === "darwin"
        ? `no ANTHROPIC_ADMIN_KEY and no Keychain item for service "${KEYCHAIN_SERVICE}"`
        : "no ANTHROPIC_ADMIN_KEY in the environment",
    );
  }

  if (flag("check")) await check(cred);

  const previous = fs.existsSync(OUT) ? safeRead(OUT) : null;
  const end = addDays(today(), 1); // exclusive; include today

  /**
   * Incremental pulls resume from what is already cached instead of always
   * re-downloading a fixed tail. We step back RECHECK_DAYS from the newest
   * cached day because the provider revises recent figures as late events land
   * (usage settles within ~5 minutes, Claude Code analytics within ~1 hour).
   * An explicit --since or --days always wins; --full ignores the cache.
   */
  const RECHECK_DAYS = Number(value("recheck", 3));
  const cachedThrough = previous?.configured && previous.days?.length
    ? previous.days[previous.days.length - 1].date
    : null;
  const explicitSince = args.includes("--since") || args.includes("--days");

  let from;
  let mode;
  if (flag("full")) {
    from = value("since", addDays(today(), -180));
    mode = "full";
  } else if (explicitSince) {
    from = value("since", addDays(today(), -Number(value("days", 14))));
    mode = "explicit";
  } else if (cachedThrough) {
    // Resume just behind the cache, but never crawl more than 30 days at once.
    const resume = addDays(cachedThrough, -RECHECK_DAYS);
    const floor = addDays(today(), -30);
    from = resume > floor ? resume : floor;
    mode = "resume";
  } else {
    from = addDays(today(), -14);
    mode = "first-run";
  }

  const cachedDayCount = previous?.days?.length || 0;
  console.log(`Console sync ${from} -> ${end}  (${mode}, credential: ${cred.sourceLabel}, tz ${TZ})`);
  if (mode === "resume") {
    console.log(`  reusing ${cachedDayCount} cached day(s) through ${cachedThrough}; re-checking the last ${RECHECK_DAYS}`);
  }

  writeProgress({
    running: true,
    phase: "starting",
    done: 0,
    total: planRequests(from, end, !flag("no-claude-code")),
    startedAt: new Date().toISOString(),
    mode,
  });

  // Days older than the refetch window are carried forward from the previous run.
  const carried = (previous?.days || []).filter((d) => d.date < from);

  let customerTypes = previous?.claudeCodeCustomerTypes || [];
  const warnings = [];
  let authProblem = null;
  try {
    await fetchUsage(from, end, cred);
    await fetchCost(from, end, cred);
    if (!flag("no-claude-code")) {
      const found = await fetchClaudeCode(from, end, cred);
      if (found.length) customerTypes = found;
    }
  } catch (error) {
    // A partial pull is still worth writing; the UI shows the warning.
    if (error.authProblem) authProblem = error.authProblem;
    warnings.push(error.message);
    console.error(`\n! ${error.message}\n`);
  }

  /**
   * A run that failed partway must never regress the cache. Days inside the
   * refetch window that we did not reach keep their previously stored values;
   * on a clean run, absence is authoritative and stale days are dropped.
   */
  const fetched = assemble();
  let rows = [...carried, ...fetched];
  if (warnings.length > 0) {
    const seen = new Set(rows.map((d) => d.date));
    const rescued = (previous?.days || []).filter((d) => !seen.has(d.date));
    if (rescued.length) {
      console.log(`  pull incomplete: keeping ${rescued.length} previously cached day(s) rather than dropping them`);
      rows = [...rows, ...rescued];
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const out = {
    configured: true,
    generatedAt: new Date().toISOString(),
    timezone: TZ,
    keySource: cred.sourceLabel,
    credentialKind: cred.kind,
    credentialLabel: KIND_LABEL[cred.kind],
    window: { from, to: end, mode, cachedThrough, reusedDays: mode === "resume" ? cachedDayCount : 0 },
    requestCount,
    warnings,
    /** Set when the credential authenticated but was refused. Drives the UI's fix-it panel. */
    authProblem,
    /**
     * "subscription" here means the org's Claude Code runs on Pro/Team seats, so
     * it is NOT billed through the Console usage endpoint and cannot double-count
     * against the local-log column. "api" means it IS in that endpoint, and the
     * merge step subtracts it out.
     */
    claudeCodeCustomerTypes: customerTypes,
    method: {
      usage: "GET /usage_report/messages, bucket_width=1h, re-bucketed into BURN_TZ local days",
      cost: "GET /cost_report, bucket_width=1d UTC, then apportioned across the local days each UTC day spans, per token type, using the measured hourly token distribution",
      claude_code: "GET /usage_report/claude_code, one UTC day per request, aggregated across actors, then apportioned to local days on the same distribution",
      apportionment: "window totals are exact; per-day cost and Claude Code attribution is derived from hourly token shares because the provider reports those two on UTC days only",
      privacy: "no email addresses, api key names, workspace ids, or free-text cost descriptions are stored",
    },
    days: rows,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  clearProgress();

  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const tokens = rows.reduce((s, r) => s + r.usage_total, 0);
  const cents = rows.reduce((s, r) => s + r.cost.cents, 0);
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}: ${rows.length} day(s), ${requestCount} request(s)`);
  console.log(`billed tokens ${fmt(tokens)} | cost $${(cents / 100).toFixed(2)}`);
  if (customerTypes.length) console.log(`claude code customer type: ${customerTypes.join(", ")}`);
  if (authProblem) {
    console.log(`\n${authProblem.status} — credential not permitted. Run \`npm run data:console:check\` for a capability breakdown.`);
  } else if (!rows.length) {
    console.log(
      "\nNo billed usage in this window. That is the expected result if your Claude Code\n" +
      "runs on a Pro/Max subscription rather than a Console API key - subscription traffic\n" +
      "is not metered by these endpoints. The dashboard will keep showing local-log columns.",
    );
  }
}

function safeRead(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * --check: probe what this credential is actually allowed to do, without
 * fetching or writing any data. Prints a capability table. This is the fastest
 * way to tell "wrong key type" from "right key, wrong org role" from "org not
 * entitled" - all three of which surface as an indistinguishable 403.
 */
async function check(cred) {
  console.log(`Credential: ${KIND_LABEL[cred.kind]} from ${cred.sourceLabel}\n`);
  const yesterday = addDays(today(), -1);
  const probes = [
    ["organization info", "/me", []],
    ["usage report", "/usage_report/messages", [
      ["starting_at", `${yesterday}T00:00:00Z`], ["bucket_width", "1d"], ["limit", "1"],
    ]],
    ["cost report", "/cost_report", [
      ["starting_at", `${yesterday}T00:00:00Z`], ["bucket_width", "1d"], ["limit", "1"],
    ]],
    ["claude code analytics", "/usage_report/claude_code", [["starting_at", yesterday], ["limit", "1"]]],
  ];

  let lastProblem = null;
  let orgInfoOk = false;
  for (const [label, pathname, params] of probes) {
    try {
      await apiGet(pathname, params, cred);
      if (pathname === "/me") orgInfoOk = true;
      console.log(`  ok      ${label}`);
    } catch (error) {
      const p = error.authProblem;
      if (p) lastProblem = p;
      console.log(`  ${String(p?.status || "fail").padEnd(6)}  ${label}`);
    }
  }

  if (lastProblem) {
    // The organization-info probe is the discriminator: if even that is refused,
    // the account almost certainly has no organization, rather than the wrong role.
    if (!orgInfoOk) {
      console.log(
        "\nDIAGNOSIS: 'organization info' was refused too, so this is not an endpoint-specific\n" +
        "permission gap. The most likely cause is that this Console account has no organization.\n" +
        "The Admin API does not exist for individual accounts — which is also why\n" +
        "Settings > Admin keys returns Page not found.\n\n" +
        "Next step: https://platform.claude.com/settings/organization — set up an organization,\n" +
        "then Settings > Admin keys becomes available and can mint an sk-ant-admin01- key.",
      );
    }
    console.log(`\n${lastProblem.guidance}`);
    if (lastProblem.requestId) console.log(`\nrequest_id: ${lastProblem.requestId}`);
  } else {
    console.log("\nAll endpoints reachable. Run `npm run data:console` to pull.");
  }
  process.exit(lastProblem ? 1 : 0);
}

main().catch((error) => {
  clearProgress();
  console.error(`fetch-console failed: ${error.message}`);
  process.exit(1);
});
