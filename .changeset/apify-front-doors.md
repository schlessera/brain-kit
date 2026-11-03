---
"@schlessera/brain": minor
"@schlessera/brain-common": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Apify's governed operations reach every front door (#3162): `brain apify <discover|inspect|prepare|run|status|results|abort> --json`, the core MCP server's `brain_apify_*` tools, and the same-named bridge tools in both chat backends all call one implementation and return one envelope. Apify stays off until the governance policy enables it. A standalone CLI or MCP process needs `APIFY_TOKEN` and the shared ledger named by the new `BRAIN_APIFY_LEDGER`, and admits a run only by an exact standing grant. Voice and autonomous turns cannot use the tools. Two additive refusal codes, `provider_unavailable` and `invalid_input`, and a new `apify_result` taint source.
