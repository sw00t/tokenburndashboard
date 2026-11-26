/**
 * Serves data/burn-meta.json (per-lane freshness, written by build-rows.mjs) so
 * the freshness strip updates after a pull without a reload. Dates and
 * timestamps only; it passes the same deploy scrub as daily-burn.json.
 */
import { serveJsonFile } from "../../../lib/server/local-only";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return serveJsonFile(request, "data/burn-meta.json", "data/burn-meta.sample.json");
}
