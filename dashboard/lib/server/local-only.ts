import fs from "node:fs/promises";
import path from "node:path";

/**
 * These routes read and write files on this machine (and one shells out), so
 * they answer only requests that arrived on a loopback Host. A deployed copy
 * returns 404 for all of them.
 */
export function isLoopback(request: Request) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export const notFound = () => new Response("Not found", { status: 404 });

/**
 * Serves a JSON file under the project root, uncached. When it does not exist
 * yet (a fresh clone before `npm run data`), serves the committed sample
 * instead; a 500 names the file only when neither is readable.
 */
export async function serveJsonFile(request: Request, relativePath: string, samplePath?: string) {
  if (!isLoopback(request)) return notFound();
  for (const candidate of samplePath ? [relativePath, samplePath] : [relativePath]) {
    try {
      const text = await fs.readFile(path.join(process.cwd(), candidate), "utf8");
      return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch {
      /* try the next candidate */
    }
  }
  return Response.json({ error: `${path.basename(relativePath)} not readable` }, { status: 500 });
}
