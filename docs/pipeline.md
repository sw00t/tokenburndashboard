# Pipeline

Three scripts, each writing one file. `npm run data` runs all three.

```
~/.codex/**, ~/.claude/**        ->  extract-exact.mjs  ->  data/private/exact-daily.json
Usage & Cost Admin API           ->  fetch-console.mjs  ->  data/private/console-daily.json
those two + estimates.json       ->  build-rows.mjs     ->  data/daily-burn.json  (public)
```

Only the last file is public, and the merge refuses to write evidence text that
looks like a path, email, key or id.

## extract-exact.mjs — measured local usage

Reads Codex session rollouts, Claude Code CLI session logs, and desktop agent
audit logs. De-duplicates by assistant message id, because the same response can
appear in more than one log. Buckets by local day.

`fresh` = input + cache creation + output. `cached` = cache reads. Both count
toward burn; they are shaded separately everywhere.

Where session logs have been pruned, it falls back to the aggregate stats cache.
Those numbers double-count streamed lines and bucket by UTC, so they are scaled by
a **measured** de-duplication ratio taken from days where both sources exist, and
labelled `derived` — never `exact`.

## fetch-console.mjs — billed usage and cost

Pulls three endpoints: hourly token usage, daily cost, and Claude Code analytics.

**The clock trap.** Usage is fetchable hourly, but cost and Claude Code analytics
are UTC-day only, while rows are local days. Joining on a date string misfiles
7–8 hours of every day. The script keeps hourly counts split by
`(UTC day -> local day)` and apportions each UTC day's cost and Claude Code totals
across the local days it spans, per token type.

> Sanity check after any change here: **no day may report more Claude Code tokens
> than that day's total usage.** If one does, the clocks have drifted apart again.
> This is exactly how the bug was originally caught.

Incremental pulls resume from the cache and re-check a short tail, because the
provider revises recent figures. A failed pull never regresses the cache.

## build-rows.mjs — the merge

Combines the two private files with your hand-written estimates, subtracts
Claude Code overlap when `customer_type` says the traffic is API-billed, applies
driver rules and splits, scrubs evidence, and writes the public file.

## Reconciliation — read one direction only

Local logs and the meter are **not symmetric**:

- **`local > billed`** — expected, not drift. Subscription-billed Claude Code
  never reaches an organization's meter. This is a billing split.
- **`billed > local`** — actionable. The invoice records work the extraction
  missed: pruned logs, a de-duplication bug, or a machine never read.

The panel headlines the second case. Do not reintroduce a single drift
percentage; it reads as an extractor bug on every subscription-billed day.
