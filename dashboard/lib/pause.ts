/**
 * Pause: replace this tab's live page with a static copy of itself (current DOM
 * plus every applied stylesheet, no scripts). The tab then has no dependency on
 * the dev server, so it keeps rendering after `npm run dev` stops. A file is
 * written only if the user confirms the prompt.
 */
export function pauseInPlace() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const css = Array.from(document.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n");
  const main = document.querySelector("main");
  if (!main) return;
  const clone = main.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button").forEach((button) => {
    button.setAttribute("disabled", "");
    button.setAttribute("title", "Paused view: controls are inactive");
  });
  const html = `<!doctype html>
<html lang="en" style="background:${document.documentElement.style.background};color-scheme:${document.documentElement.style.colorScheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Burn Dashboard (paused ${stamp})</title>
<style>${css}</style>
<style>
.pausedBanner{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:12px;padding:8px 14px;font:700 12px/1.4 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#06232b;background:#ffdf43}
.pausedBanner button{margin-left:auto;width:26px;height:26px;border:1px solid rgba(6,35,43,.4);border-radius:6px;background:transparent;color:#06232b;font:700 16px/1 system-ui,sans-serif;cursor:pointer}
.pausedBanner button:hover{background:rgba(6,35,43,.12)}
</style>
</head>
<body style="background:${document.body.style.background};color:${document.body.style.color}">
<div class="pausedBanner" role="status">Paused view captured ${stamp}. Static copy; controls are inactive. Use the back button or reopen the dev URL to return to the live page.<button type="button" aria-label="Close banner" onclick="this.parentNode.remove()">&times;</button></div>
${clone.outerHTML}
</body>
</html>`;

  const saveCopy = window.confirm(
    `Pause will freeze this tab as a static view.\n\nAlso save a copy as an HTML file (token-burn-paused-${stamp}.html)?\n\nOK = pause and save a file.  Cancel = pause only, no file.`,
  );

  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));

  if (saveCopy) {
    const link = document.createElement("a");
    link.href = url;
    link.download = `token-burn-paused-${stamp.replace(/[: ]/g, "-")}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // Navigate this tab to the static copy. A real navigation discards every script of the live
  // page, including Next's hot-reload client, which would otherwise call location.reload()
  // once it gives up reconnecting to a stopped dev server.
  window.location.assign(url);
}
