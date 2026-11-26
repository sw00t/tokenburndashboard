import type { BurnRow } from "./burn-data";

export type WindowKey = "3m" | "6m" | "1y" | "all";

/** Time windows, counted in calendar months back from the newest row. */
export const windows: { key: WindowKey; label: string; months: number | null }[] = [
  { key: "3m", label: "3M", months: 3 },
  { key: "6m", label: "6M", months: 6 },
  { key: "1y", label: "1Y", months: 12 },
  { key: "all", label: "All", months: null },
];

export function getWindowRows(rows: BurnRow[], windowKey: WindowKey) {
  const months = windows.find((w) => w.key === windowKey)?.months ?? null;
  if (months === null || rows.length === 0) return rows;

  // Same day of the month, `months` earlier, exclusive: 3M ending Nov 25 starts Aug 26.
  const firstDate = toUtcDate(rows[rows.length - 1].date);
  firstDate.setUTCMonth(firstDate.getUTCMonth() - months);
  firstDate.setUTCDate(firstDate.getUTCDate() + 1);

  return rows.filter((row) => toUtcDate(row.date) >= firstDate);
}

export function toUtcDate(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

/** "2026-11-25" -> "Nov 25". */
export function shortDate(date: string) {
  return toUtcDate(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
