---
"@schlessera/brain-ui-server": patch
---
Check private-state isolation once per warm turn after acquiring its startup checkpoint. Reuse the verdict only for a synchronous maintenance-cache hit, and recheck cold preparation after asynchronous work while retaining named turn refusal and automatic recovery.
