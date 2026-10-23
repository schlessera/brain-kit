---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain": minor
"@schlessera/brain-module-images": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-common": minor
---

The `brain` CLI's paid providers work again in governed and strict turn workers, through a metered host relay, and the worker still holds no provider key (#1673). On a host with managed native storage, each such turn gets a relay beside its egress proxy. Gemini embeddings, Gemini completions without video, Anthropic completions, and OpenAI and Gemini images send their native requests to it. The server adds the key, records each request's usage on the turn, counts it toward the turn, conversation and day budgets, and refuses the next request with `budget_exceeded` once a budget is blocked. Nothing is reserved, so requests already in flight can take a budget slightly past its stop. `brain search` uses its vectors again instead of falling back to keyword results. `brain video watch` and the `jev` reranker are not relayed and still report `provider_unavailable`.

A relayed Claude API-key turn no longer breaks `anthropic-haiku`. The CLI used to send the turn's inference placeholder and fail authentication; it now reaches the host's `ANTHROPIC_API_KEY` through the relay.

Credentialed maintenance (search from the UI, cron jobs, module actions) on those hosts also runs without `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the brain's `.env*`, and uses its own relay. A run started from a turn's tool is charged to that turn; any other run counts toward the UTC day. Keys the relay does not carry, such as `TYPESAFE_API_KEY`, stay as before. Hosts without managed native storage are unchanged, and worker-host status says so.

The budget receipt's `coverage` now reads "Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered". Receipts stored earlier keep the old text, and the schema accepts both. Gemini embeddings are priced at Google's list price per input modality. Image requests stay unpriced, and their reported tokens count toward the unpriced-token stops.

**Migration:** the relay sends a key only to its own first-party origin. If you point a built-in provider at a custom endpoint (`GOOGLE_GEMINI_BASE_URL`, `GEMINI_BASE_URL`, `OPENAI_BASE_URL`), or use a custom `apiKeyEnv`, list that key and exact origin in the new `BRAIN_UI_CLI_PROVIDER_ORIGINS`, for example `GEMINI_API_KEY=https://gateway.ithaca.invalid`. Until you do, the relay refuses those requests. Keys must be in the server's environment; a key kept only in the brain's `.env` no longer reaches relayed maintenance. A governed turn with an `allowlist` egress policy needs the provider's host on that allowlist.
