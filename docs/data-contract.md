# Data contract

The dashboard renders one JSON array, one object per local day, from
`dashboard/data/daily-burn.json` (your real data, gitignored) or
`daily-burn.sample.json` (the committed synthetic seed).

## Required fields

```json
{
  "date": "2026-03-14",
  "codex_tokens": 184320,
  "claude_code_tokens": 512880,
  "claude_code_calls": 47,
  "claude_chat_est": 38000,
  "chatgpt_est": 21000,
  "total": 756200,
  "driver": "shipping",
  "evidence": "short, shareable reason this day was heavy"
}
```

`total` is the sum of the source columns. If absent it is computed.

## Optional: measurement detail

| Field | Meaning |
| --- | --- |
| `codex_cached`, `claude_code_cached`, `console_cached` | The cache-read subset of each source column |
| `codex_fidelity`, `claude_code_fidelity`, `chat_fidelity` | `billed` \| `exact` \| `derived` \| `estimated` \| `none` |

## Optional: the billed lane

Present only when Console sync is configured.

| Field | Meaning |
| --- | --- |
| `console_tokens` | Metered API usage **with local-log overlap already subtracted**, so it sums into `total` without double counting |
| `console_cached` | Cache reads within that |
| `console_fidelity` | `billed` or `none` |
| `cost_usd` | Real money for the day |
| `cost_cached_usd` | The slice of it spent re-reading cached context |
| `cost_fidelity` | `billed` or `none` |
| `billed_claude_code_tokens` | Reconciliation **only** — never summed into `total` |
| `console_models` | `{model: tokens}`, scaled so the parts sum to `console_tokens` |

`cost_usd` and `billed_claude_code_tokens` originate on **UTC** days and are
apportioned onto local days by the measured hourly token distribution (per token
type for cost). Window totals are exact; per-day values are derived. Never join a
raw UTC-day figure onto a local-day row.

## Optional: split drivers

A day need not belong to one driver. In `data/private/estimates.json`, a day or
rule may carry `driver_split`:

```json
"2026-03-14": {
  "driver_split": { "shipping": 0.6, "research": 0.4 },
  "evidence_public": "a day split across two kinds of work"
}
```

Shares normalise to 1 and publish as `driver_split` on the row. `driver` stays the
largest share so single-label views still have one answer. The Drivers panel
distributes tokens *and* cost by share.

## Rules

- Bucket dates in the local working timezone (`BURN_TZ`) before aggregating.
- Keep measured, billed and estimated values in separate columns. Never merge them.
- Keep `driver` labels short and boring: shipping, research, review, video,
  planning, admin, support, writing.
- `evidence` explains why a day spiked, and must be safe to publish.
- Never include raw logs, chat exports, client names, project ids, file paths,
  email addresses, or secrets.
