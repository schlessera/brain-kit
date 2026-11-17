---
"@schlessera/brain-backend-claude": patch
---

Fix (#3788): a hosted Claude turn no longer sees the in-worker core server's `mcp__brain__brain_apify_*` tools. A worker holds neither the Apify token nor the ledger, so those copies could only refuse with `ledger_unset`, under the same names and descriptions as the working `mcp__brain-ui__brain_apify_*` tools. Every Claude session now disallows them, whatever the configuration, as it already does the in-worker compute tools. The host's Apify tools and standalone `brain mcp` are unchanged.
