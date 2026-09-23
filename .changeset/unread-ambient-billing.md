---
"@schlessera/brain-ui-server": minor
---

`ServerConfig.agent` no longer carries `ambientBilling`. Nothing read it after #253, when turns started clearing the API key. Cron rollups still classify billing exactly as before; #293 decides what replaces that rule.
