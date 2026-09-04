/**
 * Serves the current data/daily-burn.json so the page can refresh itself after a
 * pull without a full reload (and without depending on dev-server HMR).
 *
 * This is the same scrubbed file that ships publicly - it carries no paths,
 * emails, ids, or secrets, because build-rows.mjs refuses to write those.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

function isLoopback(request: Request) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export async function GET(request: Request) {
  if (!isLoopback(request)) return new Response("Not found", { status: 404 });
  try {
    // Real generated data when present; otherwise the committed sample, so a
    // fresh clone serves something rather than erroring.
    const dir = process.cwd();
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, "data/daily-burn.json"), "utf8");
    } catch {
      text = await fs.readFile(path.join(dir, "data/daily-burn.sample.json"), "utf8");
    }
    return new Response(text, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "daily-burn.json not readable" }, { status: 500 });
  }
}
