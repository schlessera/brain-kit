---
"@schlessera/brain-module-jobs": minor
---

Removed the `remoteineurope` board, which was retired because its domain now
redirects every page to We Work Remotely (already scraped as `weworkremotely`).
It is gone from `ALL_SOURCES` and the default `SOURCES`. `jobs scrape
remoteineurope` now exits 1 and says the board was retired, where it used to
report "Unknown source". A `boards` config that names it gets the same reason
as a warning, and the other boards still run. The new `RETIRED_SOURCES` export
lists retired names with their reasons.
