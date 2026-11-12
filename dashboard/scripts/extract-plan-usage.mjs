#!/usr/bin/env node
/**
 * extract-plan-usage.mjs
 *
 * Reads the Claude desktop app's local plan-utilization history and writes
 * data/private/plan-usage-daily.json. The app samples the subscription's
 * rate-limit meters every ~5 minutes:
 *   fh  five-hour window utilization, percent
 *   sd  seven-day window utilization, percent
 *   xu  extra-usage spend indicator (kept private, not published)
 * Per local day we keep the peak of each. Percentages only: no ids, no text.
 *
 * This is a measured signal for the subscription as a whole (chat + Claude
 * Code on the plan), not a token count, so the dashboard shows it beside the
 * chat estimate rather than replacing the estimate in the totals.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TZ = process.env.BURN_TZ
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || "UTC";
const SRC = path.join(os.homedir(), "Library/Application Support/Claude/plan-usage-history.json");
const OUT = path.resolve(process.cwd(), "data/private/plan-usage-daily.json");
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

if (!fs.existsSync(SRC)) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ available: false, reason: "plan-usage-history.json not found", days: [] }, null, 2));
  console.log("plan usage: desktop history not found; lane stays empty.");
  process.exit(0);
}
const samples = JSON.parse(fs.readFileSync(SRC, "utf8")).samples || [];
const days = new Map();
for (const s of samples) {
  const date = dayFmt.format(new Date(s.t));
  const d = days.get(date) || { date, five_hour_pct: 0, seven_day_pct: 0, samples: 0, extra_usage_seen: false };
  d.five_hour_pct = Math.max(d.five_hour_pct, s.u?.fh || 0);
  d.seven_day_pct = Math.max(d.seven_day_pct, s.u?.sd || 0);
  d.extra_usage_seen = d.extra_usage_seen || (s.u?.xu || 0) > 0;
  d.samples += 1;
  days.set(date, d);
}
const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ available: true, generatedAt: new Date().toISOString(), timezone: TZ, sampleCount: samples.length, days: rows }, null, 2));
const peak7 = rows.reduce((a, b) => (b.seven_day_pct > a.seven_day_pct ? b : a), rows[0]);
const peak5 = rows.reduce((a, b) => (b.five_hour_pct > a.five_hour_pct ? b : a), rows[0]);
console.log(`Wrote data/private/plan-usage-daily.json: ${rows.length} day(s) from ${samples.length} samples (${rows[0]?.date} -> ${rows.at(-1)?.date})`);
console.log(`plan usage: 7-day peak ${peak7?.seven_day_pct}% on ${peak7?.date}, 5-hour peak ${peak5?.five_hour_pct}% on ${peak5?.date}`);
