---
"@schlessera/brain": minor
"@schlessera/brain-common": minor
"@schlessera/brain-ui-server": minor
---

Apify catalog discovery and the approval of a concrete Actor are now separate policy decisions (#3160). The governance policy's `apify` block accepts `discovery` and `actors`, each `deny`, `ask` or `allow` and `ask` by default, and `actor_grants`, a list of exact standing grants. `brain policy check --json` reports all three under `effective.apify`. Discovery permission never lets an Actor run. With `actors: allow`, a run skips review only when an unexpired grant matches its account, immutable Actor id, exact build, qualified profile, input-schema and pricing fingerprints, target origins and run cap. Every other run is reviewed once. An approval never becomes a standing grant. The server checks every fact the proposal bound again before and after approval, and refuses a changed Actor, build, schema, price, account, policy or input. Voice, autonomous and surfaceless turns are never prompted. Catalog searches use only Apify's `search-actors` and `fetch-actor-details` MCP tools, with telemetry off, and their results are handled as untrusted. No Actor build is qualified to run yet, and this release adds no CLI command, MCP tool or paid run.
