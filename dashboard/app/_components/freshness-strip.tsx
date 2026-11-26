"use client";

import { useState } from "react";

import { shortDate } from "../../lib/date-windows";
import { type BurnMeta, laneStatuses } from "../../lib/freshness";
import { formatAge } from "../../lib/use-console-sync";

/**
 * One line per data lane: how far its data runs and when its source was last
 * read. A lane not re-read within its window is flagged, because stale data and
 * a quiet week look identical in every chart.
 *
 * Collapsed to one slim row by default: the newest data day, the lane count,
 * and how many lanes are stale (the left edge also turns amber), so a stale
 * lane is never hidden behind the fold.
 *
 * Ages depend on the clock, so they render only after hydration; the prerendered
 * HTML shows dates alone and cannot disagree with the client.
 */
export function FreshnessStrip({ meta, hydrated, canPull }: { meta: BurnMeta | null; hydrated: boolean; canPull: boolean }) {
  const [open, setOpen] = useState(false);
  if (!meta || meta.lanes.length === 0) return null;
  const statuses = laneStatuses(meta, hydrated ? Date.now() : Number.NaN);
  const staleCount = hydrated ? statuses.filter((s) => s.stale).length : 0;
  const newest = statuses.map((s) => s.lane.lastDataDay).filter(Boolean).sort().at(-1);
  return (
    <section className={`freshness${staleCount > 0 ? " hasStale" : ""}`} aria-label="Data freshness">
      <button type="button" className="freshnessToggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="label">Data as of</span>
        <span className="freshnessSummary">
          {newest ? `through ${shortDate(newest)}` : "no data yet"}, {statuses.length} lanes
          {staleCount > 0 && <em>, {staleCount} stale</em>}
        </span>
        <span className="freshnessChevron" aria-hidden>
          {open ? "Hide ▴" : "Details ▾"}
        </span>
      </button>
      {open && (
        <ul>
          {statuses.map(({ lane, ageMs, stale }) => {
            const flagged = hydrated && stale;
            const fix = lane.kind === "manual" ? "import a newer export" : canPull ? "press Pull now" : "run npm run data";
            return (
              <li key={lane.key} className={flagged ? "stale" : ""} title={`${lane.label}: ${lane.detail}`}>
                <strong>{lane.label}</strong>
                <span>
                  {lane.lastDataDay ? `through ${shortDate(lane.lastDataDay)}` : "no data yet"}
                  {hydrated && ` · read ${formatAge(ageMs)}`}
                </span>
                {flagged && <em>stale: {fix}</em>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
