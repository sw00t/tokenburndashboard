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
 *
 * The desktop app keeps only a recent window of samples, so each run merges
 * with the previous output instead of replacing it: days no longer in the source
 * are kept, and a day seen both times keeps the higher peaks (a peak can only be
 * lost to pruning, never lowered by new samples). `--rebuild` ignores history.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { TZ, loadHistory, localDay, writeJsonAtomic } from "./lib/common.mjs";

const SRC = path.join(os.homedir(), "Library/Application Support/Claude/plan-usage-history.json");
const OUT = path.resolve(process.cwd(), "data/private/plan-usage-daily.json");

if (!fs.existsSync(SRC)) {
  if (fs.existsSync(OUT)) {
    console.log("plan usage: desktop history not found; keeping the stored days unchanged.");
  } else {
    writeJsonAtomic(OUT, { available: false, reason: "plan-usage-history.json not found", days: [] });
    console.log("plan usage: desktop history not found; lane stays empty.");
  }
  process.exit(0);
}

const samples = JSON.parse(fs.readFileSync(SRC, "utf8")).samples || [];
const days = new Map();
for (const s of samples) {
  const date = localDay(s.t);
  const d = days.get(date) || { date, five_hour_pct: 0, seven_day_pct: 0, samples: 0, extra_usage_seen: false };
  d.five_hour_pct = Math.max(d.five_hour_pct, s.u?.fh || 0);
  d.seven_day_pct = Math.max(d.seven_day_pct, s.u?.sd || 0);
  d.extra_usage_seen = d.extra_usage_seen || (s.u?.xu || 0) > 0;
  d.samples += 1;
  days.set(date, d);
}

const previous = loadHistory(OUT);
let kept = 0;
for (const p of previous?.days || []) {
  const d = days.get(p.date);
  if (!d) {
    days.set(p.date, p);
    kept += 1;
    continue;
  }
  d.five_hour_pct = Math.max(d.five_hour_pct, p.five_hour_pct || 0);
  d.seven_day_pct = Math.max(d.seven_day_pct, p.seven_day_pct || 0);
  d.extra_usage_seen = d.extra_usage_seen || !!p.extra_usage_seen;
  d.samples = Math.max(d.samples, p.samples || 0);
}

const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
writeJsonAtomic(OUT, { available: true, generatedAt: new Date().toISOString(), timezone: TZ, sampleCount: samples.length, days: rows });

if (kept) console.log(`plan usage: kept ${kept} earlier day(s) no longer in the desktop app's history`);
const peakOf = (key) => rows.reduce((a, b) => (b[key] > a[key] ? b : a), rows[0]);
const peak7 = peakOf("seven_day_pct");
const peak5 = peakOf("five_hour_pct");
console.log(`Wrote data/private/plan-usage-daily.json: ${rows.length} day(s) from ${samples.length} samples (${rows[0]?.date} -> ${rows.at(-1)?.date})`);
console.log(`plan usage: 7-day peak ${peak7?.seven_day_pct}% on ${peak7?.date}, 5-hour peak ${peak5?.five_hour_pct}% on ${peak5?.date}`);
