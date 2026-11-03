---
"@schlessera/brain": minor
"@schlessera/brain-common": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Apify can now be enabled explicitly, and only on the host (#3159). The governance policy accepts `apify: { enabled: true }`; it defaults to `false`, and `brain policy check --json` reports `effective.apify`. While it is off the server contacts no Apify endpoint, even when `APIFY_TOKEN` is set. When it is on, the server reads `APIFY_TOKEN` from its own environment, confirms the account with the fixed Apify API, and binds that account. A token for a different account needs an owner's confirmation in Settings first. Disabling Apify, removing or revoking the token, or changing the account invalidates authority bound earlier, and re-enabling starts fresh. The token is never passed to any subprocess or worker, not even through `BRAIN_UI_SUBPROCESS_ENV_EXTRA`, and never appears in a response, record, URL or error. Owners can read the state (`disabled`, `authentication_required`, `configured` or `unavailable`) from the internal `GET /api/apify` route. This release does not search the Apify catalogue, run Actors or spend money.
