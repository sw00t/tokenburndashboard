"use client";

import { type CSSProperties, type ReactNode, useState } from "react";

import { type BurnRow, rowFidelityLabel } from "../../lib/burn-data";
import { shortDate } from "../../lib/date-windows";
import type { Palette } from "../../lib/themes";
import {
  type CalendarCell,
  FRESH_FULL_SHARE,
  calendarWeeks,
  formatPercent,
  formatTokens,
  formatUsd,
  heatColor,
  heatStyle,
} from "../../lib/token-math";
import { DollarIcon, LeafIcon, Panel } from "./panel";

type HeatMetric = "total" | "fresh" | "cost";

const METRIC_NAME: Record<HeatMetric, string> = { total: "Total tokens", fresh: "Fresh tokens", cost: "Billed cost" };
const METRIC_FACE: Record<HeatMetric, ReactNode> = { total: "total", fresh: <LeafIcon />, cost: <DollarIcon /> };

/**
 * Daily burn as a calendar: weeks are columns on desktop (fitted to the panel,
 * never scrolling) and rows on phones. Colour is a log scale of the chosen
 * metric; hue shifts from cached to fresh with the day's fresh share.
 */
export function HeatmapPanel({ rows, showCost, palette }: { rows: BurnRow[]; showCost: boolean; palette: Palette }) {
  const [chosen, setChosen] = useState<HeatMetric>("total");
  const metric: HeatMetric = chosen === "cost" && !showCost ? "total" : chosen;
  const metrics: HeatMetric[] = showCost ? ["total", "fresh", "cost"] : ["total", "fresh"];

  const value = (row: BurnRow) => (metric === "total" ? row.total : metric === "fresh" ? row.fresh : row.cost_usd);
  // In cost mode the fresh/cached mix is the money split, not the token split.
  const mix = (row: BurnRow) => (metric === "cost" ? row.cost_usd - row.cost_cached_usd : row.fresh);
  const max = Math.max(...rows.map(value), 0);
  const weeks = calendarWeeks(rows);
  const cellStyle = (row: BurnRow) => heatStyle(value(row), mix(row), max, palette);

  return (
    <Panel
      label="Daily burn"
      title="Heatmap"
      note="Log color scale. Accent-coloured cells are cache-read heavy; the more a cell shifts to the second colour, the larger its fresh share. Faint lines mark month starts."
      action={
        <div className="toggle" role="group" aria-label="Heatmap metric">
          {metrics.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={metric === option}
              aria-label={METRIC_NAME[option]}
              title={METRIC_NAME[option]}
              onClick={() => setChosen(option)}
            >
              {METRIC_FACE[option]}
            </button>
          ))}
        </div>
      }
    >
      <Calendar weeks={weeks} cellStyle={cellStyle} />
      <WeekRows weeks={weeks} value={value} cellStyle={cellStyle} money={metric === "cost"} />
      <div className="legend" aria-hidden>
        <span>less</span>
        {[0.2, 0.4, 0.6, 0.8, 1].map((n) => (
          <i key={n} style={{ background: heatColor(Math.pow(10, n * 6), 0, 1_000_000, palette) }} />
        ))}
        <span>more</span>
        <span className="legendGap">cached</span>
        {[0, 0.25, 0.5, 0.75, 1].map((share) => (
          <i key={share} style={{ background: heatColor(1_000_000, 1_000_000 * share * FRESH_FULL_SHARE, 1_000_000, palette) }} />
        ))}
        <span>fresh ({Math.round(FRESH_FULL_SHARE * 100)}%+)</span>
      </div>
    </Panel>
  );
}

function cellTitle(cell: CalendarCell) {
  const row = cell.row;
  if (!row) return `${cell.date}: no recorded usage`;
  return (
    `${row.date}: ${formatTokens(row.total)} tokens (${formatPercent(row.fresh, row.total)} fresh)` +
    (row.cost_usd > 0 ? `, ${formatUsd(row.cost_usd)} billed` : "") +
    `, ${row.driver}, ${rowFidelityLabel(row).text}`
  );
}

/** Desktop: one column per week, sized so the whole window fits the panel. */
function Calendar({ weeks, cellStyle }: { weeks: CalendarCell[][]; cellStyle: (row: BurnRow) => CSSProperties }) {
  // The gap between cells narrows as the range grows (a year is ~53 columns).
  const style = {
    "--weeks": Math.max(1, weeks.length),
    "--cal-gap": weeks.length > 80 ? "1px" : weeks.length > 53 ? "2px" : weeks.length > 26 ? "3px" : "4px",
  } as CSSProperties;
  return (
    <div className="calendarWrap deskOnly">
      <div className="calendar" style={style} aria-label="Daily token burn heatmap">
        <div className="dayLabels" aria-hidden>
          {["Mon", "", "Wed", "", "Fri", "", "Sun"].map((label, index) => (
            <span key={index}>{label}</span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0].date} className="week">
            {week.map((cell, dayIndex) => {
              const title = cellTitle(cell);
              return (
                <span
                  key={cell.date}
                  className={`cell${cell.row ? "" : " empty"}${monthEdgeClass(cell.date, dayIndex)}`}
                  style={cell.row ? cellStyle(cell.row) : undefined}
                  title={title}
                  tabIndex={cell.row ? 0 : -1}
                  aria-label={title}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Month boundaries. Weeks are columns (Mon at the top), so a month that starts
 * mid-week gives a stepped edge: a line on the left of every cell whose same
 * weekday a week earlier was in another month, and a line on top of the 1st
 * when it is not a Monday. CSS draws both in the gaps between cells.
 */
function monthEdgeClass(date: string, dayIndex: number) {
  const month = date.slice(0, 7);
  const monthOf = (offsetDays: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 7);
  };
  const left = monthOf(-7) !== month;
  const top = dayIndex > 0 && monthOf(-1) !== month;
  return `${left ? " monthLeft" : ""}${top ? " monthTop" : ""}`;
}

/**
 * Phone: one row per week, newest first, seven day cells plus a bar for the
 * week's total. Same colour scale as the desktop calendar, turned to fit a tall screen.
 */
function WeekRows({
  weeks,
  value,
  cellStyle,
  money,
}: {
  weeks: CalendarCell[][];
  value: (row: BurnRow) => number;
  cellStyle: (row: BurnRow) => CSSProperties;
  money: boolean;
}) {
  const LIMIT = 12;
  const [all, setAll] = useState(false);
  const rows = [...weeks].reverse().map((week) => ({
    start: week[0].date,
    cells: week,
    total: week.reduce((sum, cell) => sum + (cell.row ? value(cell.row) : 0), 0),
  }));
  const maxWeek = Math.max(...rows.map((r) => r.total), 1);
  const shown = all ? rows : rows.slice(0, LIMIT);
  const fmt = (n: number) => (money ? formatUsd(n) : formatTokens(n));
  // Linear on purpose: the cells already carry the log colour scale, so the bar shows true proportion.
  const width = (n: number) => (n > 0 ? Math.max(3, (n / maxWeek) * 100) : 0);
  return (
    <div className="weekRows phoneOnly">
      <div className="weekRow weekHead" aria-hidden>
        <span />
        <span className="weekCells">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </span>
        <span>week</span>
      </div>
      {shown.map((week) => (
        <div key={week.start} className="weekRow">
          <span className="weekLabel">{shortDate(week.start)}</span>
          <span className="weekCells">
            {week.cells.map((cell) => {
              const title = cell.row ? `${cell.date}: ${fmt(value(cell.row))}, ${cell.row.driver}` : `${cell.date}: no recorded usage`;
              return (
                <span
                  key={cell.date}
                  className={`cell${cell.row ? "" : " empty"}`}
                  style={cell.row ? cellStyle(cell.row) : undefined}
                  title={title}
                  aria-label={title}
                />
              );
            })}
          </span>
          <span className="weekTotal">
            <i style={{ width: `${width(week.total)}%` }} />
            <b>{week.total > 0 ? fmt(week.total) : "–"}</b>
          </span>
        </div>
      ))}
      {rows.length > LIMIT && (
        <button type="button" className="expand weekMore" onClick={() => setAll((prev) => !prev)}>
          {all ? `Latest ${LIMIT} weeks` : `All ${rows.length} weeks`}
        </button>
      )}
    </div>
  );
}
