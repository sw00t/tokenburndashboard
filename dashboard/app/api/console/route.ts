/**
 * Console sync control plane.
 *
 * GET  -> status: schedule, last pull, whether a credential exists, freshness.
 * POST -> { action: "pull" }              run fetch-console.mjs + build-rows.mjs
 *         { action: "schedule", everyHours: number | null }
 *         { action: "pull-full" }         backfill instead of the incremental tail
 *
 * The Admin API key is read inside scripts/fetch-console.mjs, from the macOS
 * Keychain, and is never read here, never logged, and never serialised into a
 * response. `hasCredential` is a boolean and nothing more.
 *
 * This is a localhost developer tool: it shells out, so it refuses any request
 * that did not arrive on a loopback Host.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const dynamic = "force-dynamic";

const ROOT = process.cwd();
const STATE = path.join(ROOT, "data/private/console-state.json");
const CONSOLE_DATA = path.join(ROOT, "data/private/console-daily.json");
const PROGRESS = path.join(ROOT, "data/private/console-progress.json");

export type ScheduleState = {
  everyHours: number | null;
  lastPullAt: string | null;
  lastOk: boolean | null;
  lastMessage: string;
  running: boolean;
};

const DEFAULT_STATE: ScheduleState = {
  everyHours: null,
  lastPullAt: null,
  lastOk: null,
  lastMessage: "",
  running: false,
};

/** Only one pull at a time, per server process. */
let inFlight: Promise<PullResult> | null = null;

type PullResult = { ok: boolean; message: string; log: string };

function isLoopback(request: Request) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeState(next: ScheduleState) {
  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(next, null, 2));
}

/** Strips anything that could carry a secret out of subprocess output. */
function safeLog(text: string) {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .split("\n")
    .slice(-40)
    .join("\n")
    .trim();
}

async function status() {
  const state = await readJson<ScheduleState>(STATE, DEFAULT_STATE);
  const data = await readJson<{
    configured?: boolean;
    reason?: string;
    generatedAt?: string;
    keySource?: string;
    keychainService?: string;
    setupHint?: string;
    warnings?: string[];
    claudeCodeCustomerTypes?: string[];
    credentialLabel?: string;
    authProblem?: {
      status: number;
      kind: string;
      kindLabel: string;
      guidance: string;
      requestId: string;
    } | null;
    days?: unknown[];
  }>(CONSOLE_DATA, {});

  // Written by fetch-console.mjs on every request; absent when nothing is running.
  // A file that has stopped ticking means the run died without cleaning up
  // (SIGKILL, a crashed shell) - treat it as finished rather than showing a
  // progress bar that will never move again.
  const rawProg = await readJson<{
    running?: boolean; phase?: string; done?: number; total?: number; pct?: number;
    mode?: string; updatedAt?: string;
  } | null>(PROGRESS, null);
  const STALE_MS = 3 * 60_000;
  const progAge = rawProg?.updatedAt ? Date.now() - Date.parse(rawProg.updatedAt) : Infinity;
  const prog = rawProg && progAge < STALE_MS ? rawProg : null;

  const lastPullAt = state.lastPullAt || data.generatedAt || null;
  const ageMs = lastPullAt ? Date.now() - Date.parse(lastPullAt) : null;
  const due =
    state.everyHours != null && (ageMs === null || ageMs >= state.everyHours * 3_600_000);

  return {
    schedule: state.everyHours,
    lastPullAt,
    lastOk: state.lastOk,
    lastMessage: state.lastMessage,
    running: inFlight !== null || prog?.running === true,
    progress: prog
      ? {
          phase: prog.phase || "working",
          done: prog.done || 0,
          total: prog.total || 0,
          pct: prog.pct || 0,
          mode: prog.mode || "",
        }
      : null,
    due,
    ageMs,
    // Boolean only. The key itself never leaves the fetch script.
    hasCredential: data.configured === true,
    notConfiguredReason: data.configured === false ? data.reason || "" : "",
    // Where it should be stored, so the UI can show the exact setup command.
    keychainService: data.keychainService || "token-burn-console",
    setupHint:
      data.setupHint || 'security add-generic-password -U -a "$USER" -s token-burn-console -w',
    keySource: data.keySource || "",
    credentialLabel: data.credentialLabel || "",
    // Present when the credential authenticated but was refused (403) or rejected (401).
    authProblem: data.authProblem || null,
    warnings: data.warnings || [],
    claudeCodeCustomerTypes: data.claudeCodeCustomerTypes || [],
    billedDays: Array.isArray(data.days) ? data.days.length : 0,
  };
}

async function pull(full: boolean): Promise<PullResult> {
  const fetchArgs = ["scripts/fetch-console.mjs", ...(full ? ["--full"] : [])];
  let log = "";
  try {
    const fetched = await run(process.execPath, fetchArgs, {
      cwd: ROOT,
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    log += fetched.stdout + fetched.stderr;
    const built = await run(process.execPath, ["scripts/build-rows.mjs"], {
      cwd: ROOT,
      timeout: 2 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    log += "\n" + built.stdout + built.stderr;
    const summary =
      built.stdout
        .split("\n")
        .find((line) => line.startsWith("console:")) ||
      built.stdout.split("\n").find((line) => line.startsWith("Wrote")) ||
      "Pull complete.";
    return { ok: true, message: summary.trim(), log: safeLog(log) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    log += (err.stdout || "") + (err.stderr || "") + (err.message || "");
    const clean = safeLog(log);
    const firstError =
      clean.split("\n").find((l) => /error|failed|401|403|429/i.test(l)) || "Pull failed.";
    return { ok: false, message: firstError.trim().slice(0, 300), log: clean };
  }
}

async function startPull(full: boolean) {
  if (inFlight) return inFlight;
  const state = await readJson<ScheduleState>(STATE, DEFAULT_STATE);
  inFlight = pull(full).then(async (result) => {
    await writeState({
      ...state,
      lastPullAt: new Date().toISOString(),
      lastOk: result.ok,
      lastMessage: result.message,
      running: false,
    });
    inFlight = null;
    return result;
  }).catch(async (error) => {
    inFlight = null;
    const message = error instanceof Error ? error.message : "Pull failed.";
    await writeState({ ...state, lastPullAt: new Date().toISOString(), lastOk: false, lastMessage: message, running: false });
    return { ok: false, message, log: "" };
  });
  return inFlight;
}

export async function GET(request: Request) {
  if (!isLoopback(request)) return new Response("Not found", { status: 404 });
  return Response.json(await status());
}

export async function POST(request: Request) {
  if (!isLoopback(request)) return new Response("Not found", { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    everyHours?: number | null;
  };

  if (body.action === "schedule") {
    const allowed = [null, 1, 6, 24];
    const next = body.everyHours ?? null;
    if (!allowed.includes(next)) {
      return Response.json({ error: "everyHours must be null, 1, 6, or 24" }, { status: 400 });
    }
    const state = await readJson<ScheduleState>(STATE, DEFAULT_STATE);
    await writeState({ ...state, everyHours: next });
    return Response.json(await status());
  }

  if (body.action === "pull" || body.action === "pull-full") {
    const result = await startPull(body.action === "pull-full");
    return Response.json({ ...(await status()), result });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
