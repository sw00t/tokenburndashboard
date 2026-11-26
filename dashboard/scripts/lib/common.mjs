/**
 * Helpers shared by the data scripts. Everything here is plain Node with no
 * dependencies, so each script stays runnable on its own with `node`.
 */
import fs from "node:fs";
import path from "node:path";

/** Timezone every local day is bucketed in. Override with BURN_TZ. */
export const TZ = process.env.BURN_TZ || "America/Los_Angeles";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

/** YYYY-MM-DD in TZ for an ISO timestamp or epoch milliseconds. */
export const localDay = (when) => dayFormat.format(new Date(when));

/** Shift a YYYY-MM-DD calendar date by n days (UTC arithmetic, no TZ involved). */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Parse a JSON file, or return `fallback` when it does not exist. Malformed JSON still throws. */
export function readJsonIfExists(file, fallback = null) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

/**
 * Write JSON (2-space indent, no trailing newline) via a temp file and rename,
 * so an interrupted run never leaves a truncated file behind.
 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * The previous output of a merging script, or null on a first run or with
 * --rebuild. Exits instead of merging when that file is unreadable, or when it
 * was bucketed in a different timezone (merging would mix day boundaries).
 */
export function loadHistory(file) {
  if (process.argv.includes("--rebuild") || !fs.existsSync(file)) return null;
  const shown = path.relative(process.cwd(), file);
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Refusing to run: ${shown} exists but is not valid JSON (${error.message}).`);
    console.error("Restore it from a backup, or pass --rebuild to start over from the source on disk.");
    process.exit(1);
  }
  if (previous.timezone && previous.timezone !== TZ) {
    console.error(`Refusing to merge: ${shown} is bucketed in ${previous.timezone}, this run uses ${TZ}. Pass --rebuild to re-bucket from the source.`);
    process.exit(1);
  }
  return previous;
}
