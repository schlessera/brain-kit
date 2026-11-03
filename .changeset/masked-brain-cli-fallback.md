---
"@schlessera/brain-ui-server": patch
---

A brain without a packaged CLI (`node_modules/.bin/brain`) whose `scripts/brain-cli.ts` fallback is protected now reads its taxonomy and builds a provider-restricted turn's private index in the masked worker (#2865). The worker launcher admits only an absolute executable, so the fallback's `bun` used to be refused as an unavailable worker boundary; every `types:` provider selector then refused and the private index stayed incomplete. The masked worker now runs the fallback on the server's own Bun, the runtime it already admits, and the script still resolves inside the turn's immutable startup view with no added mount. Host CLI calls and packaged CLI selection are unchanged. A configured command whose executable is another relative name refuses by name before anything launches, and a failed run's detail no longer ends on Bun's version banner instead of the error.
