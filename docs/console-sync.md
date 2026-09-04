# Console sync (billed tokens and real cost)

Optional. Without it the dashboard renders exactly as it does with it, minus the
billed lane, the money strip, the model panel and reconciliation.

## What it needs

An Anthropic **Admin API key** (`sk-ant-admin01-…`) from a Claude **Console
organization**. Three ways this commonly fails:

| Symptom | Cause |
| --- | --- |
| `Settings > Admin keys` is 404 and everything returns 403 | The account has **no organization**. Individual accounts have no Admin API at all. Create one at Console → Settings → Organization. |
| `organization info` succeeds, usage/cost 403 | An org exists but your role is not **admin**. |
| Admin key, but usage/cost still 403 | A Claude Enterprise org (needs the separate claude.ai Analytics key), or the org is not entitled. |

An ordinary API key set to "organization" scope is **not** an Admin key. It
authenticates fine and then 403s, because a regular key carries the org role of
the account that owns it, and reading usage and cost requires admin.

Run the built-in probe before debugging anything else. It fetches no data and
prints the key class (never the key) with an ok/403 line per endpoint:

```bash
npm run data:console:check
```

## Storing the credential

The key goes in the macOS Keychain, never in a `.env`, the repo, or any synced
file. The bare `-w` **last** makes `security` prompt, so it never enters shell
history:

```bash
security add-generic-password -U -a "$USER" -s token-burn-console -w
```

`-U` overwrites in place when rotating. To remove it:

```bash
security delete-generic-password -s token-burn-console
```

Design notes: the UI has **no input field for the key**, deliberately.
`/api/console` returns `hasCredential` as a boolean and nothing more, and
subprocess output is filtered for key-shaped strings before it can reach a
response. On non-macOS hosts, set `ANTHROPIC_ADMIN_KEY` in the environment.

## Pulling

| Command / button | Behaviour |
| --- | --- |
| `npm run data:console` / **Pull now** | Resumes from cache: only days newer than stored, plus a short re-check window. Typically a handful of requests. |
| `npm run data:console:full` / **Backfill** | Ignores the cache, re-pulls 180 days. Slow. Only needed after changing how data is derived. |
| `npm run data:console:check` | Permissions probe, fetches nothing. |

Schedule (Manual / Hourly / Every 6h / Daily) is set in the Console sync bar and
fires while the dashboard is open. There is no system-level job.

## Rate limits

Roughly one request per minute sustained. A backfill is a burst and is tolerated,
but several in a row earn a 429 whose `retry-after` can be 5–15 minutes. The
script fails fast in that case and reports when the window reopens, rather than
sleeping through it, and a failed pull keeps every previously cached day.

## When the billed lane stays empty

That is a correct result, not a failure. These endpoints meter **API-platform
traffic only**. Claude Code running on a Pro/Max subscription is billed through
the subscription and never appears, regardless of key or org.
