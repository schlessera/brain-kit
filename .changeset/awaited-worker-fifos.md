---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
---

Keep the hosted server answering while a worker's pipes are created and while a Claude turn prepares its own sandbox. The asynchronous worker probe, agent launch and maintenance launch and run now await `mkfifo` for their stdio and status channels instead of blocking on it, and a Claude turn whose host supplies no worker sandbox awaits its scratch area's git check before building its options. The synchronous forms, the FIFO modes, the unlink-before-launch boundary, the resolved sandbox and every refusal are unchanged.
