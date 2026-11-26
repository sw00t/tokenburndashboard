# Token Burn Dashboard

Local dashboard of AI token usage across Codex, Claude Code (CLI + desktop Cowork), Claude chat, and ChatGPT, on one set of axes with exact and estimated values kept visibly separate.

## Run

```bash
npm install
npm run data     # re-extract exact usage from local logs and rebuild data/daily-burn.json
npm run dev      # http://localhost:3000
npm run build    # production build check
npm run typecheck  # TypeScript only (Next 16 removed `next lint`; no linter is configured)
```

Code layout: `app/page.tsx` holds state and page order only; each panel lives in `app/_components/`; row math, formatting, and display settings live in `lib/`; the data scripts share helpers in `scripts/lib/common.mjs`.

## How the data is made

| Step | Script | Reads | Writes |
| --- | --- | --- | --- |
| 1 | `scripts/extract-exact.mjs` | `~/.codex/**` session rollouts, `~/.claude/projects/**/*.jsonl`, `~/Library/Application Support/Claude/local-agent-mode-sessions/**/audit.jsonl`, `~/.claude/stats-cache.json` | `data/private/exact-daily.json` (private) |
| 2 | `scripts/build-rows.mjs` | `data/private/exact-daily.json` + `data/private/estimates.json` | `data/daily-burn.json` (public, scrubbed) |

`npm run data` runs both. `npm run data:build` runs only step 2 (after editing estimates).

Rules baked into the scripts:

- Days bucket in `America/Los_Angeles` (override with `BURN_TZ=...`).
- Burn = input + cache writes + cache reads + output per API call. Cache reads are counted and also reported separately (`*_cached` fields) so the heatmap can shade cached-heavy days differently from fresh-heavy days.
- `claude_code_calls` = unique Claude Code API responses (message ids) that day.
- Claude Code CLI logs write one line per content block, so the same message id repeats. The extractor de-duplicates. The stats cache does not, and it buckets by UTC. Days that only survive in the stats cache are scaled by the measured de-duplication ratio and labeled **derived**. Days older than the per-day cache are spread from message counts and labeled **estimated**.
- History is merged, never replaced. Claude Code, Codex, and Cowork all prune their own logs, so `extract-exact.mjs` and `extract-plan-usage.mjs` merge each run with their previous output: a day whose logs were deleted keeps its stored figure, and an exact day never shrinks. Lanes kept this way carry `preservedFrom` in the private file. `--rebuild` ignores history; only use it when every log you care about is still on disk. Back up `data/private/` before trying it.
- Codex days whose session logs were pruned before any extraction are filled from Codex's own database (`~/.codex/state_5.sqlite`, read-only), labeled **derived**. It keeps one total per session, so it is a lower bound (a compaction resets the counter) and each session lands on the day it started. Days with exact Codex logs are never touched.
- Claude Code's own pruning is off once `"cleanupPeriodDays"` is set high in `~/.claude/settings.json` (it is set to 3650 here). Codex and Cowork have no such setting, which is why the merge matters.
- Chat columns are estimates from an interview (see `data/private/estimates.json`) and never merge into exact columns.
- `build-rows.mjs` refuses to publish an `evidence_public` string that looks like a path, email, URL, key, or UUID.

## Add the next day of data

1. Exact sources: just run `npm run data`. New Codex, Claude Code, and Cowork sessions are picked up automatically. The dashboard's **Pull now** button (and its schedule) does the same: local logs first, then the Console, then the rebuild. Console pulls resume from the last day fully fetched, and flags reach the fetcher: `npm run data:console -- --since 2026-09-01`.
2. Driver and evidence for that day: add an entry to `data/private/estimates.json`:

   ```json
   "days": {
     "2026-09-04": {
       "driver": "shipping",
       "evidence_public": "dashboard polish and review",
       "evidence_private": "anything you want, this never ships",
       "claude_chat_est": 45000,
       "chatgpt_est": 0
     }
   }
   ```

   `claude_chat_est` / `chatgpt_est` are optional. When omitted, the per-source `per_active_day` value applies on days with Codex or Claude Code activity. Days with only Console or OpenAI API traffic count as idle, since a scheduled job says nothing about chat use. Ranges of days can use `driverRules` (`from`, `to`, `driver`, `evidence_public`).
3. Run `npm run data:build` (or `npm run data`) and reload.

## Data freshness

The slim row under the hero (collapsed by default) shows the newest data day, the lane count, and how many lanes are stale; its left edge turns amber when any lane is. Expanded, it lists every data lane with how far its data runs ("through Nov 25") and when its source was last read ("read 2h ago"). A lane not re-read within its window is marked **stale** with the fix: 48 hours for local logs, the Console, and the plan meter, 35 days for the manual OpenAI export. Stale data and a quiet week look the same in every chart, so this strip is the only place the difference shows. It is written by `build-rows.mjs` to `data/burn-meta.json` and refreshes after every pull.

## Display controls

The header row holds the time range (**3M / 6M / 1Y / All**, calendar months back from the newest row) and one chip per source to show or hide it. Each chip carries its provider's mark (Anthropic, OpenAI, Ollama) in its trust-tier colour. Each source's trust tier (billed, exact, derived, estimated) appears on hover, as it does on tiles, heatmap cells, model names, and table rows; the "i" button lists all four.

The sliders icon next to the "i" opens the appearance settings, saved in the browser's localStorage (phones reach them through the "⋯" settings sheet):

- **Title / Figures / Panel figures** step the title, the four summary tiles, and the peak-day tiles from 50% to 200% independently.
- **Density** scales page padding, panel gaps, tile padding, and table row height from 20% to 200%. Every spacing rule has a pixel floor so nothing collapses or overlaps at the dense end.
- **Palette** switches between six colour sets (Ink, Paper, Forest, Ember, Dusk, Mono). Heatmap and trend colours follow the palette.
- **Pause** freezes the current tab: it navigates to a static copy of the page held in a blob URL (DOM plus styles, no scripts), so nothing can reload it after `npm run dev` stops. Next's own dev client would otherwise reload the tab once it gives up reconnecting, which is why an in-place rewrite is not enough. A banner with a close button marks the paused state. You are asked first whether to also save the copy as an HTML file; nothing is written unless you confirm. Use the back button or reopen the dev URL to return to the live page.
- The moving-average table loads collapsed to one fifth of its rows (6 of 30). The slim row along its bottom edge expands or collapses it.

## Local models lane (Ollama)

`scripts/extract-ollama.mjs` reads Ollama's server logs (`~/.ollama/logs/server*.log`) and writes `data/private/ollama-daily.json`: per local day and model, the requests, prompt tokens processed, and tokens generated, taken from llama.cpp's per-request timing lines. It runs as part of `npm run data`, `npm run data:local`, and **Pull now**; `npm run data:ollama` runs it alone.

- Labeled **exact** (the runner's own counts). A reused cached prompt prefix is not logged, so this lane has no cache-read share.
- The model is the most recent one the log shows loading, mapped from blob digests back to names via `~/.ollama/models/manifests`. With two models loaded at once, a request could be credited to the one loaded last.
- Each request takes the date of the next timestamped log line, re-bucketed into the local timezone.
- Ollama keeps only the current log plus a few rotated ones (it rotates on restart), so the extractor merges with its previous output and never drops a day it has read. `--rebuild` ignores that history.
- The Models list shows these rows with **Ollama** in the left column (`local_model_models` keys are `ollama:<model>`). The lane is not counted as "active" for chat estimates, since scripts call local models too.

## OpenAI API lane (platform export)

OpenAI does not keep usage logs on the Mac, so this lane comes from the platform's own export
(platform.openai.com, Usage, Export): a `completions_usage_<from>_<to>.csv` and a `cost_<from>_<to>.csv`.
Drop new exports into one folder and run:

```bash
npm run data:openai -- "/path/to/export/folder"   # or set OPENAI_EXPORT_DIR
npm run data:build
```

`npm run data` also runs the importer, reading `OPENAI_EXPORT_DIR` or `data/private/openai-exports/`.
Overlapping exports are fine: each day comes whole from the most recent export that has it, never summed across files. Days already imported are kept even after their CSV leaves the folder (`--rebuild` drops that history).

What it is and is not:

- Labeled **billed**: OpenAI's meter, per model, with USD from the cost export (`openai_api_usd`, kept apart from Anthropic spend).
- API-key traffic only. ChatGPT chat and Codex on a ChatGPT subscription never appear in these exports, so the ChatGPT column stays an estimate and Codex stays on local session logs. No overlap to subtract.
- UTC-day buckets, because the export carries no hourly detail to re-bucket into local days.
- Org, project, user, and key ids in the CSVs are read and dropped. Only date, model, counts, and USD reach `data/private/openai-daily.json`, and only tokens, requests, USD, and model ids reach the public file.

## Privacy

- `data/private/` is git-ignored and is the only place raw breakdowns, machine paths, and private notes live.
- `data/daily-burn.json` and `data/burn-meta.json` (lane freshness: dates and timestamps only) are the only data files the app imports. Check both before deploying:

  ```bash
  grep -nE '/|@|https?:|sk-|org-|proj_|key_' data/daily-burn.json data/burn-meta.json   # should print nothing
  ```

## Deploy

```bash
npx vercel deploy --prod
```

Do this only after confirming `data/daily-burn.json` is scrubbed. Any static host works too: `npm run build` then serve `.next` via `npm start`.
