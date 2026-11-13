/**
 * Appearance defaults for a browser with no saved settings.
 *
 * The steppers and palette live in each viewer's localStorage, which is
 * per-browser. This file is what a fresh browser (or cleared storage, or a
 * deployed copy) starts from, so "make the page look like this by default" is a
 * one-click action rather than a code edit.
 *
 * UI preferences only - no credentials, nothing derived from usage data. The
 * file ships with the app, unlike everything under data/private/.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const FILE = path.join(process.cwd(), "data/display-defaults.json");

const ALLOWED_KEYS = [
  "titleScale",
  "figureScale",
  "panelFigureScale",
  "density",
  "palette",
  "barCollapsed",
  "compact",
] as const;

function isLoopback(request: Request) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export async function GET(request: Request) {
  if (!isLoopback(request)) return new Response("Not found", { status: 404 });
  try {
    return new Response(await fs.readFile(FILE, "utf8"), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({}, { status: 200 });
  }
}

export async function POST(request: Request) {
  if (!isLoopback(request)) return new Response("Not found", { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  // Whitelist and type-check: this file is imported by the page, so a malformed
  // write would break the build rather than just look wrong.
  const next: Record<string, number | string | boolean> = {};
  for (const key of ALLOWED_KEYS) {
    const value = body[key];
    if (key === "palette") {
      if (typeof value === "string" && /^[a-z0-9-]{1,32}$/.test(value)) next[key] = value;
    } else if (key === "barCollapsed" || key === "compact") {
      if (typeof value === "boolean") next[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0.2 && value <= 2) {
      next[key] = Math.round(value * 100) / 100;
    }
  }
  if (Object.keys(next).length === 0) {
    return Response.json({ error: "no valid settings supplied" }, { status: 400 });
  }

  await fs.writeFile(FILE, `${JSON.stringify(next, null, 2)}\n`);
  return Response.json({ saved: next });
}
