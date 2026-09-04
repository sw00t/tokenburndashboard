"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { RawBurnRow } from "./burn-data";

export type ConsoleStatus = {
  schedule: number | null;
  lastPullAt: string | null;
  lastOk: boolean | null;
  lastMessage: string;
  running: boolean;
  progress: { phase: string; done: number; total: number; pct: number; mode: string } | null;
  due: boolean;
  ageMs: number | null;
  hasCredential: boolean;
  notConfiguredReason: string;
  keychainService: string;
  setupHint: string;
  keySource: string;
  credentialLabel: string;
  authProblem: {
    status: number;
    kind: string;
    kindLabel: string;
    guidance: string;
    requestId: string;
  } | null;
  warnings: string[];
  claudeCodeCustomerTypes: string[];
  billedDays: number;
};

export const SCHEDULE_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Manual" },
  { value: 1, label: "Hourly" },
  { value: 6, label: "Every 6h" },
  { value: 24, label: "Daily" },
];

/** How often the open page asks the server whether a scheduled pull is due. */
const HEARTBEAT_MS = 60_000;
/** While a pull is running, poll fast enough for the progress bar to move. */
const PROGRESS_MS = 1_500;

/**
 * Drives the Console sync lane: status polling, the schedule setting, and manual
 * pulls. Scheduling is evaluated server-side (the route owns `due`), so the page
 * only has to keep asking while it is open. Nothing here ever sees a credential.
 */
export function useConsoleSync(onRows: (rows: RawBurnRow[]) => void) {
  const [status, setStatus] = useState<ConsoleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const busyRef = useRef(false);
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;

  const refreshRows = useCallback(async () => {
    try {
      const res = await fetch("/api/burn-rows", { cache: "no-store" });
      if (!res.ok) return;
      const rows = (await res.json()) as RawBurnRow[];
      if (Array.isArray(rows) && rows.length) onRowsRef.current(rows);
    } catch {
      /* keep the statically imported rows */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/console", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as ConsoleStatus;
      setStatus(next);
      setUnreachable(false);
      return next;
    } catch {
      // A paused/exported copy of this page has no server. Fail quiet.
      setUnreachable(true);
      return null;
    }
  }, []);

  const pull = useCallback(
    async (full = false) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await fetch("/api/console", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: full ? "pull-full" : "pull" }),
        });
        if (res.ok) {
          const next = (await res.json()) as ConsoleStatus;
          setStatus(next);
          await refreshRows();
        }
      } catch {
        setUnreachable(true);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [refreshRows],
  );

  const setSchedule = useCallback(async (everyHours: number | null) => {
    try {
      const res = await fetch("/api/console", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "schedule", everyHours }),
      });
      if (res.ok) setStatus((await res.json()) as ConsoleStatus);
    } catch {
      setUnreachable(true);
    }
  }, []);

  // The POST that runs a pull does not resolve until the pull finishes, so the
  // progress bar needs its own faster poll while one is in flight.
  const running = busy || status?.running === true;
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const id = setInterval(() => {
      if (!cancelled) load();
    }, PROGRESS_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, load]);

  // Replace the committed sample with this machine's real rows, if any.
  useEffect(() => {
    refreshRows();
  }, [refreshRows]);

  useEffect(() => {
    let cancelled = false;
    const beat = async () => {
      const next = await load();
      if (cancelled || !next) return;
      // The server decides what "due" means; the page just honours it.
      if (next.due && !next.running && next.schedule != null && !busyRef.current) {
        await pull(false);
      }
    };
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load, pull]);

  return { status, busy, unreachable, pull, setSchedule, refreshRows };
}

export function formatAge(ms: number | null) {
  if (ms == null) return "never";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
