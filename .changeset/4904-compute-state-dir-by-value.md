---
"@schlessera/brain-ui-server": patch
---

`createApp({ dbPath })` decides by value whether the compute state directory follows the database (#4904). A spread copy of resolved compute settings now moves beside the opened database (or is cleared for `":memory:"`), a resolved directory an embedder changed in place is kept, and a configuration without compute settings returns a handle whose `config.compute` is the settings compute uses.
