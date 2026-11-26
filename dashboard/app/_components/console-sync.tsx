"use client";

import { useState } from "react";

import { type ConsoleStatus, SCHEDULE_OPTIONS, formatAge, useConsoleSync } from "../../lib/use-console-sync";

export type Sync = ReturnType<typeof useConsoleSync>;
type Tone = "working" | "idle" | "bad" | "ok";

/** The status dot's colour, shared by the desktop bar and the phone line. */
export function syncTone(status: ConsoleStatus, busy: boolean): Tone {
  if (busy || status.running) return "working";
  if (!status.hasCredential) return "idle";
  if (status.authProblem || status.lastOk === false) return "bad";
  return "ok";
}

const billedDaysText = (status: ConsoleStatus) =>
  `${status.billedDays} billed day${status.billedDays === 1 ? "" : "s"} · updated ${formatAge(status.ageMs)}`;

/** Phone only: one tappable line standing in for the Console sync bar. */
export function PhoneSyncLine({ sync, onOpen }: { sync: Sync; onOpen: () => void }) {
  const { status, busy, unreachable } = sync;
  if (unreachable || !status) return null;
  const tone = syncTone(status, busy);
  const text =
    tone === "working"
      ? `Pulling from Console${status.progress ? ` · ${status.progress.pct}%` : ""}`
      : tone === "idle"
        ? "Console not connected"
        : tone === "bad"
          ? "Console sync needs attention"
          : billedDaysText(status);
  return (
    <button type="button" className="phoneSync phoneOnly" onClick={onOpen}>
      <span className={`syncDot ${tone}`} aria-hidden />
      {text}
      <span aria-hidden className="phoneSyncChevron">›</span>
    </button>
  );
}

/**
 * Console sync controls: schedule, manual pull, and the setup path.
 *
 * The setup path shows the command to run but never accepts a key through the
 * UI; there is no input here on purpose. The key goes into the Keychain via the
 * user's own terminal and is read only by the fetch script, server-side.
 */
export function ConsoleSyncBar({ sync }: { sync: Sync }) {
  const { status, busy, unreachable } = sync;
  const [copied, setCopied] = useState(false);
  // Pressing Pull now / Backfill folds away any setup, auth, or warning panels so
  // the bar shows only pull progress and status. They stay folded after the pull
  // finishes until the user reopens them with "Show details".
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);

  // A paused/exported copy of this page has no server behind it.
  if (unreachable || !status) return null;

  const auth = status.authProblem;
  const tone = syncTone(status, busy);
  const running = tone === "working";
  const prog = status.progress;

  const startPull = (full: boolean) => {
    setDetailsCollapsed(true);
    sync.pull(full);
  };

  const showSetup = !status.hasCredential;
  const showWarnings = status.hasCredential && !auth && status.warnings.length > 0;
  const hasDetails = showSetup || Boolean(auth) || showWarnings;
  const detailsVisible = hasDetails && !running && !detailsCollapsed;

  const summary = running
    ? prog && prog.total > 0
      ? `${prog.phase} · ${prog.done}/${prog.total} requests`
      : "Starting…"
    : !status.hasCredential
      ? "Not connected"
      : auth
        ? `${auth.status} — credential not permitted`
        : status.lastOk === false
          ? status.lastMessage || "Last pull failed"
          : billedDaysText(status);

  const copySetup = async () => {
    try {
      await navigator.clipboard.writeText(status.setupHint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; the command is visible on screen anyway */
    }
  };

  const setupCommand = (
    <div className="syncCmd">
      <code>{status.setupHint}</code>
      <button type="button" onClick={copySetup}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );

  return (
    <section className="syncBar" aria-label="Console sync">
      <div className="syncLead">
        <span className="label">Console sync</span>
        <span className={`syncDot ${tone}`} aria-hidden />
        <span className="syncSummary">{summary}</span>
      </div>

      {running && (
        <div
          className="syncProgress"
          role="progressbar"
          aria-valuenow={prog?.pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Console pull progress"
        >
          <span className="syncProgressTrack">
            <i style={{ width: `${Math.max(2, prog?.pct ?? 0)}%` }} />
          </span>
          <span className="syncPct">{prog?.pct ?? 0}%</span>
        </div>
      )}

      <div className="syncSchedule" role="group" aria-label="Automatic pull interval">
        <span className="label">Every</span>
        {SCHEDULE_OPTIONS.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={status.schedule === option.value}
            disabled={!status.hasCredential}
            onClick={() => sync.setSchedule(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="syncActions">
        <button
          type="button"
          className="syncPull"
          onClick={() => startPull(false)}
          disabled={running}
          title="Refreshes local logs, then resumes the Console pull from cached data: only days newer than what is stored, plus a short re-check window for figures the provider is still revising."
        >
          {running ? "Pulling…" : "Pull now"}
        </button>
        <button
          type="button"
          className="syncBackfill"
          onClick={() => startPull(true)}
          disabled={running}
          title="Ignore the cache and re-pull the last 180 days. Slow: one request per week of tokens, one per day of Claude Code analytics."
        >
          Backfill 180d
        </button>
        {hasDetails && !running && (
          <button type="button" className="syncDetailsToggle" onClick={() => setDetailsCollapsed(!detailsCollapsed)}>
            {detailsCollapsed ? "Show details" : "Hide details"}
          </button>
        )}
      </div>

      {detailsVisible && showSetup && (
        <div className="syncSetup">
          <p>
            {status.notConfiguredReason
              ? `No credential found (${status.notConfiguredReason}).`
              : "No credential found."}{" "}
            Store an Admin API key in your Keychain, then press Pull now. Run this in a terminal —
            the bare <code>-w</code> at the end makes it prompt, so the key never lands in your shell
            history, this repo, or any synced file:
          </p>
          {setupCommand}
          <p className="muted">
            Needs an Admin API key (<code>sk-ant-admin01-…</code>) from Console → Settings → Admin
            keys, created by an org admin. Regular and workspace-scoped keys are refused by these
            endpoints, and the Admin API is unavailable to individual accounts without an
            organization. If your Claude Code runs on a Pro/Max subscription, expect this lane to
            stay empty — subscription traffic is not metered here.
          </p>
        </div>
      )}

      {detailsVisible && auth && (
        <div className="syncSetup syncAuthProblem">
          <p>
            <strong>
              HTTP {auth.status} using a {auth.kindLabel}.
            </strong>{" "}
            The credential reached Anthropic and was understood — it simply is not permitted to read
            organization usage and cost. This is a permissions problem, not a bad key.
          </p>
          <p>{auth.guidance}</p>
          {auth.kind === "plain-key" && (
            <div className="syncCmd">
              <code>https://platform.claude.com/settings/admin-keys</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText("https://platform.claude.com/settings/admin-keys").catch(() => {});
                }}
              >
                Copy
              </button>
            </div>
          )}
          <p className="muted">
            Once you have the new key, replace the stored one with the same command as before — the{" "}
            <code>-U</code> flag overwrites in place:
          </p>
          {setupCommand}
          <p className="muted">
            To see exactly which endpoints the current credential can reach, run{" "}
            <code>npm run data:console:check</code>.
            {auth.requestId ? ` Support reference: ${auth.requestId}.` : ""}
          </p>
        </div>
      )}

      {detailsVisible && showWarnings && <p className="syncWarn">{status.warnings.join(" · ")}</p>}
    </section>
  );
}
