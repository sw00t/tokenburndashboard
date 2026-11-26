/**
 * Per-lane freshness, read from data/burn-meta.json (written by build-rows.mjs).
 *
 * A lane whose source has not been re-read looks exactly like a lane with no
 * usage, so the dashboard has to say how old each lane is. "Refreshed" means
 * when the source was last read, which is what goes stale; "through" is the
 * newest day with any tokens, which can legitimately be old on a quiet lane.
 */
export type FreshnessLane = {
  key: string;
  label: string;
  detail: string;
  kind: "auto" | "manual";
  refreshedAt: string | null;
  lastDataDay: string | null;
  staleAfterHours: number;
};

export type BurnMeta = { builtAt: string; lanes: FreshnessLane[] };

export type LaneStatus = {
  lane: FreshnessLane;
  /** ms since the source was last read; null when it never was */
  ageMs: number | null;
  stale: boolean;
};

export function laneStatuses(meta: BurnMeta | null, nowMs: number): LaneStatus[] {
  if (!meta?.lanes) return [];
  return meta.lanes.map((lane) => {
    const at = lane.refreshedAt ? Date.parse(lane.refreshedAt) : Number.NaN;
    const ageMs = Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
    const stale = ageMs === null || ageMs > lane.staleAfterHours * 3_600_000;
    return { lane, ageMs, stale };
  });
}

/** Normalises whatever the JSON import or the API returned; never throws. */
export function asBurnMeta(value: unknown): BurnMeta | null {
  const v = value as Partial<BurnMeta> | null;
  if (!v || !Array.isArray(v.lanes)) return null;
  return { builtAt: String(v.builtAt || ""), lanes: v.lanes as FreshnessLane[] };
}
