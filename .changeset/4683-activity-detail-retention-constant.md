---
"@schlessera/brain-ui-server": patch
---

The Activity prune keeps a finished run's span detail for a fixed seven days (#4683). An `activity.retention.detailDays` row in the settings table is no longer read; nothing ever wrote one, so a host keeps the seven days it already had. `detailRetention.days` in the runtime stats stays 7.
