# data/private/

Everything in this directory is **gitignored** and never ships.

| File | Written by | Contains |
| --- | --- | --- |
| `exact-daily.json` | `scripts/extract-exact.mjs` | Per-day totals from your local session logs, plus machine paths, for auditing |
| `console-daily.json` | `scripts/fetch-console.mjs` | Billed usage and cost from the Usage & Cost Admin API |
| `console-state.json` / `console-progress.json` | the `/api/console` route | Sync schedule, last-pull result, live progress |
| `estimates.json` | you, by hand | Chat estimates, driver rules, and private evidence notes |

Start from `dashboard/data/estimates.example.json`:

```bash
cp dashboard/data/estimates.example.json dashboard/data/private/estimates.json
```

Only `data/daily-burn.json` is public, and `build-rows.mjs` refuses to write
evidence text that looks like a path, email, key, or id.

**No credential is stored here or anywhere else in the repo.** The Admin API key
lives in the macOS Keychain; see the root README.
