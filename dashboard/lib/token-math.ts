import type { CSSProperties } from "react";

import type { BurnRow } from "./burn-data";
import { toUtcDate } from "./date-windows";

export function formatTokens(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

export function formatPercent(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : "0%";
}

/** Money, sized to the figure: sub-dollar spend still needs to read as a number. */
export function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "$0";
  const abs = Math.abs(value);
  if (abs >= 10_000) return `$${(value / 1000).toFixed(1)}K`;
  if (abs >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs === 0) return "$0";
  return `$${value.toFixed(3)}`;
}

/** Blended rate for the window. The single number that makes caching legible. */
export function costPerMillion(usd: number, tokens: number) {
  if (!tokens) return 0;
  return (usd / tokens) * 1_000_000;
}

export function sumTokens(rows: BurnRow[]) {
  return rows.reduce((sum, row) => sum + row.total, 0);
}

/** 0..1 position of a value on a log scale that tops out at max. */
export function logNormalize(value: number, max: number) {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(1, Math.log10(value + 1) / Math.log10(max + 1));
}

export function logHeatLevel(value: number, max: number) {
  return Math.max(0, Math.min(5, Math.ceil(logNormalize(value, max) * 5)));
}

import { type Palette, defaultPalette } from "./themes";

/** Share of fresh tokens at which a cell reads as fully "fresh" coloured. */
export const FRESH_FULL_SHARE = 0.25;

export function heatColor(total: number, fresh: number, max: number, palette: Palette = defaultPalette, alphaFloor = 0.1) {
  const n = logNormalize(total, max);
  if (n === 0) return "rgba(var(--ink-rgb), 0.05)";
  const mix = Math.min(1, total ? fresh / total / FRESH_FULL_SHARE : 0);
  const rgb = palette.cached.map((c, i) => Math.round(c + (palette.fresh[i] - c) * mix));
  const alpha = alphaFloor + (1 - alphaFloor) * n;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
}

export function heatStyle(total: number, fresh: number, max: number, palette: Palette = defaultPalette): CSSProperties {
  return { background: heatColor(total, fresh, max, palette) };
}

export function movingAverage7(rows: BurnRow[], index: number) {
  const start = Math.max(0, index - 6);
  const windowRows = rows.slice(start, index + 1);
  return sumTokens(windowRows) / windowRows.length;
}

export type WeekTotal = { week: string; total: number; fresh: number; cached: number; days: number };

export function weeklyTotals(rows: BurnRow[]): WeekTotal[] {
  const totals = new Map<string, WeekTotal>();

  for (const row of rows) {
    const week = startOfIsoWeek(row.date);
    const entry = totals.get(week) || { week, total: 0, fresh: 0, cached: 0, days: 0 };
    entry.total += row.total;
    entry.fresh += row.fresh;
    entry.cached += row.cached;
    entry.days += 1;
    totals.set(week, entry);
  }

  // Fill empty weeks so the x-axis is linear in time.
  const list = Array.from(totals.values()).sort((a, b) => a.week.localeCompare(b.week));
  if (list.length < 2) return list;
  const filled: WeekTotal[] = [];
  const cursor = toUtcDate(list[0].week);
  const end = toUtcDate(list[list.length - 1].week);
  const byWeek = new Map(list.map((w) => [w.week, w]));
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    filled.push(byWeek.get(key) || { week: key, total: 0, fresh: 0, cached: 0, days: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return filled;
}

export type CalendarCell = { date: string; row: BurnRow | null };

/** Weeks (Mon..Sun) spanning the selected rows, including inactive days as empty cells. */
export function calendarWeeks(rows: BurnRow[]): CalendarCell[][] {
  if (rows.length === 0) return [];
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const cursor = toUtcDate(startOfIsoWeek(rows[0].date));
  const end = toUtcDate(rows[rows.length - 1].date);
  const weeks: CalendarCell[][] = [];
  while (cursor <= end) {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const date = cursor.toISOString().slice(0, 10);
      week.push({ date, row: byDate.get(date) || null });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export const WORDS_PER_TOKEN = 0.75;
export const WORDS_PER_MINUTE = 250;
export const WORDS_PER_NOVEL = 90_000;
export const WORDS_PER_PAGE = 300;
export const SPOKEN_WORDS_PER_MINUTE = 150;

/**
 * Human-scale comparisons. Every row shows its arithmetic, because a comparison
 * you cannot check is decoration. Money rows appear only once the window has a
 * real bill behind it.
 */
export function fermiScale(totalTokens: number, spendUsd = 0) {
  const words = totalTokens * WORDS_PER_TOKEN;
  const readingHours = words / WORDS_PER_MINUTE / 60;
  const novels = words / WORDS_PER_NOVEL;
  const pages = words / WORDS_PER_PAGE;
  const spokenHours = words / SPOKEN_WORDS_PER_MINUTE / 60;

  const items = [
    {
      label: "Approx. words",
      value: formatTokens(words),
      note: `${formatTokens(totalTokens)} tokens x ${WORDS_PER_TOKEN} words`,
    },
    {
      label: "Reading time",
      value: readingHours >= 48 ? `${Math.round(readingHours / 24)} days` : `${Math.round(readingHours)}h`,
      note: `${formatTokens(words)} words / ${WORDS_PER_MINUTE} wpm / 60`,
    },
    {
      label: "Novel equivalents",
      value: novels >= 100 ? `${Math.round(novels)}` : novels.toFixed(1),
      note: `${formatTokens(words)} words / ${formatTokens(WORDS_PER_NOVEL)} per novel`,
    },
    {
      label: "Printed pages",
      value: formatTokens(pages),
      note: `${formatTokens(words)} words / ${WORDS_PER_PAGE} per page`,
    },
    {
      label: "Read aloud",
      value: spokenHours >= 48 ? `${Math.round(spokenHours / 24)} days` : `${Math.round(spokenHours)}h`,
      note: `${formatTokens(words)} words / ${SPOKEN_WORDS_PER_MINUTE} wpm spoken`,
    },
  ];

  if (spendUsd > 0) {
    items.push({
      label: "Cost per novel",
      value: novels >= 0.01 ? formatUsd(spendUsd / novels) : "n/a",
      note: `${formatUsd(spendUsd)} billed / ${novels >= 100 ? Math.round(novels) : novels.toFixed(1)} novels`,
    });
  }

  return items;
}

export function startOfIsoWeek(date: string) {
  const value = toUtcDate(date);
  const day = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - day);
  return value.toISOString().slice(0, 10);
}
