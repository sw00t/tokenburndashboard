# Privacy

The local dashboard may contain detail. The published file must not.

## Never leaves the machine

- Raw session logs and chat exports
- Client names, project names, repo paths, ticket ids, email addresses, account ids
- Prompt text
- Any API key, token, cookie or `.env` value

`data/private/` is gitignored in full, and `data/daily-burn.json` — your real
generated figures — is gitignored too. The committed sample is synthetic.

## Safe to publish

Date; normalized token totals; source-level totals; fidelity labels; daily cost
and its cache-read share; generic driver labels; scrubbed evidence notes; model
identifiers.

## Enforced, not just documented

`build-rows.mjs` throws rather than publishing evidence text matching a path,
`@`, a URL, a key prefix, or a UUID fragment. Fix the note; do not weaken the
check.

Before publishing anything generated, confirm the public file is clean:

```bash
grep -nE '/|@|https?:|sk-' dashboard/data/daily-burn.json   # must print nothing
```

## Console fields dropped at the fetch boundary

The Admin API returns organization detail the public file has no business
carrying. These are discarded before anything is written to disk:

- User email addresses and API key names from Claude Code analytics — actors are
  counted, never named
- `workspace_id`, `api_key_id`, `service_account_id`, `account_id`
- Free-text cost `description` strings

Only closed enums survive: `cost_type`, `token_type`, and model ids. That is why
the cost split can be published safely.

## Scrubbing evidence

Replace specifics with work-family language:

```text
Bad:  "Acme onboarding deck, ticket PROJ-4417, export from their CRM"
Good: "shipping a customer-facing deck"
```

If the detail is the reason the day matters, keep it in `evidence_private` in
`data/private/estimates.json` and publish the generic version.
