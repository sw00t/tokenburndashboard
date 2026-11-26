"use client";

import { useState } from "react";

import type { BurnRow } from "../../lib/burn-data";
import { shortDate } from "../../lib/date-windows";
import { type WeekTotal, formatPercent, formatTokens, logNormalize, weeklyTotals } from "../../lib/token-math";
import { Panel } from "./panel";

export function TrendPanel({ rows }: { rows: BurnRow[] }) {
  const weekly = weeklyTotals(rows);
  const peakWeek = weekly.reduce<WeekTotal | undefined>((peak, week) => (!peak || week.total > peak.total ? week : peak), undefined);
  return (
    <Panel
      label="Weekly trend"
      title="Log-scaled trend"
      note={
        peakWeek ? (
          <>
            Peak week starts {peakWeek.week} at {formatTokens(peakWeek.total)} tokens.
            <br />
            Thin line is fresh tokens only; dotted spans are weeks with no recorded usage. Hover or tap a week for its figures.
          </>
        ) : (
          "No weeks in range."
        )
      }
    >
      <div className="trend">
        <TrendChart weekly={weekly} />
      </div>
    </Panel>
  );
}

const WIDTH = 720;
const HEIGHT = 260;
const PAD = { left: 46, right: 16, top: 24, bottom: 34 };
const TICKS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000];

/**
 * Weekly totals (thick) and fresh tokens (thin) on a log scale, as an SVG.
 * Each week owns a full-height hover band (tap on touch screens) that shows its
 * figures in a tooltip. The tooltip is HTML laid over the SVG so its text stays
 * readable at any chart size.
 */
function TrendChart({ weekly }: { weekly: WeekTotal[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const max = Math.max(...weekly.map((w) => w.total), 1);
  const x = (index: number) => PAD.left + (weekly.length === 1 ? plotW / 2 : (index / (weekly.length - 1)) * plotW);
  const y = (value: number) => PAD.top + plotH - logNormalize(value, max) * plotH;
  const point = (i: number, v: number) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;

  // Break the line on weeks with no recorded usage instead of plunging to the floor.
  const line = (key: "total" | "fresh") => {
    let d = "";
    let penDown = false;
    weekly.forEach((w, i) => {
      if (w[key] <= 0) {
        penDown = false;
        return;
      }
      d += `${penDown ? "L" : "M"}${point(i, w[key])} `;
      penDown = true;
    });
    return d.trim();
  };

  // Bridge each gap with a dotted segment so the eye follows the series across
  // quiet weeks without reading the gap as a measured zero.
  const bridge = (key: "total" | "fresh") => {
    const points = weekly.map((w, i) => ({ i, v: w[key] })).filter((p) => p.v > 0);
    let d = "";
    for (let n = 1; n < points.length; n += 1) {
      const [a, b] = [points[n - 1], points[n]];
      if (b.i - a.i > 1) d += `M${point(a.i, a.v)}L${point(b.i, b.v)} `;
    }
    return d.trim();
  };

  const ticks = TICKS.filter((t) => t <= max * 1.2);
  const labelEvery = Math.max(1, Math.ceil(weekly.length / 6));
  // The last week is always labelled; drop a regular label that would crowd it.
  const showLabel = (i: number) =>
    i === weekly.length - 1 || (i % labelEvery === 0 && weekly.length - 1 - i >= Math.ceil(labelEvery * 0.6));

  // Hover bands run from midpoint to midpoint between neighbouring weeks.
  const step = weekly.length > 1 ? plotW / (weekly.length - 1) : plotW;
  const active = hover !== null ? weekly[hover] : undefined;
  const anchorY = active && active.total > 0 ? y(active.total) : PAD.top + plotH / 2;

  return (
    <div className="trendPlot" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Weekly token burn trend line, log scale">
        {ticks.map((tick) => (
          <g key={tick}>
            <path d={`M${PAD.left} ${y(tick)}H${WIDTH - PAD.right}`} stroke="var(--line)" />
            <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" fill="var(--muted)" fontSize="11">
              {formatTokens(tick)}
            </text>
          </g>
        ))}
        <path d={bridge("fresh")} fill="none" stroke="var(--fresh)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="0.5 3" opacity="0.65" />
        <path d={bridge("total")} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray="0.5 3" opacity="0.75" />
        <path d={line("fresh")} fill="none" stroke="var(--fresh)" strokeWidth="2" strokeLinecap="round" />
        <path d={line("total")} fill="none" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {weekly.map((w, i) =>
          w.total > 0 ? <circle key={w.week} cx={x(i).toFixed(1)} cy={y(w.total).toFixed(1)} r="3.5" fill="var(--accent)" /> : null,
        )}
        {weekly.map((w, i) =>
          showLabel(i) ? (
            <text key={`l-${w.week}`} x={x(i)} y={HEIGHT - 10} textAnchor="middle" fill="var(--muted)" fontSize="11">
              {w.week.slice(5)}
            </text>
          ) : null,
        )}
        {active && hover !== null && (
          <g pointerEvents="none">
            <path d={`M${x(hover)} ${PAD.top}V${PAD.top + plotH}`} stroke="var(--muted)" strokeDasharray="2 4" />
            {active.fresh > 0 && <circle cx={x(hover)} cy={y(active.fresh)} r="4" fill="var(--fresh)" />}
            {active.total > 0 && <circle cx={x(hover)} cy={y(active.total)} r="6.5" fill="var(--panel)" stroke="var(--accent)" strokeWidth="3" />}
          </g>
        )}
        {weekly.map((w, i) => (
          <rect
            key={`h-${w.week}`}
            x={x(i) - step / 2}
            y={PAD.top}
            width={step}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onClick={() => setHover(i)}
          />
        ))}
      </svg>
      {active && hover !== null && <WeekTip week={active} xFrac={x(hover) / WIDTH} yFrac={anchorY / HEIGHT} />}
    </div>
  );
}

/** Slides along the x-axis with the point so it never runs off either edge; flips below points near the top. */
function WeekTip({ week, xFrac, yFrac }: { week: WeekTotal; xFrac: number; yFrac: number }) {
  const below = yFrac < 0.4;
  return (
    <div
      className="trendTip"
      style={{
        left: `${xFrac * 100}%`,
        top: `${yFrac * 100}%`,
        transform: `translate(-${xFrac * 100}%, ${below ? "14px" : "calc(-100% - 14px)"})`,
      }}
    >
      <strong>Week of {shortDate(week.week)}</strong>
      {week.total > 0 ? (
        <>
          <span>
            <b>{formatTokens(week.total)}</b> total
          </span>
          <span>
            <i className="tipFresh" /> {formatTokens(week.fresh)} fresh ({formatPercent(week.fresh, week.total)})
          </span>
          <span>{formatTokens(week.cached)} cache reads</span>
          <span className="muted">
            {week.days} active day{week.days === 1 ? "" : "s"}
          </span>
        </>
      ) : (
        <span className="muted">No recorded usage</span>
      )}
    </div>
  );
}
