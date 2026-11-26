/**
 * Serves the current data/daily-burn.json so the page can refresh itself after a
 * pull without a full reload. This is the same scrubbed file that ships
 * publicly: no paths, emails, ids, or secrets, because build-rows.mjs refuses
 * to write those.
 */
import { serveJsonFile } from "../../../lib/server/local-only";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return serveJsonFile(request, "data/daily-burn.json", "data/daily-burn.sample.json");
}
