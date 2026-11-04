---
"@schlessera/brain-backend-pi": patch
---

The pi backend's worker session is now split into worker launch, a table of RPC handlers with one per method, receipt persistence and the protocol reader. Its curated tools are now one named factory per tool, grouped into file tools, brain tools and the routing for application tools. Turns behave as before: tool names, schemas, results, permission decisions and the worker protocol are unchanged.
