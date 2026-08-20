---
"@schlessera/brain-render-puppeteer": minor
"@schlessera/brain-scrape": minor
---

Make browser crash recovery testable, and give the scraper the recovery it was
missing.

Both packages launch Chrome lazily and cache the handle. A few lines decide
whether a crashed browser is replaced on the next call or leaves a dead handle
cached until the process restarts — and with `puppeteer.launch` hardcoded, the
only way to exercise them was to start real Chrome and kill it. Both now take a
`launch` option, so a fake browser can be crashed on demand.

**`brain-render-puppeteer`** gains the seam and tests for all four behaviours
that were previously "verified by inspection": a crashed browser is replaced; a
FAILED launch is not cached (a rejected promise left there is returned to every
future caller, so one transient failure — Chrome mid-install, a momentary OOM —
disables rendering for the life of the process); a late crash handler cannot
discard the browser that already replaced it; and repeated failures keep
retrying rather than latching. Four of the five tests fail against the code
with the recovery removed.

**`brain-scrape` had no recovery at all.** Its session was modelled on the
renderer's lifecycle but shipped without the `disconnected` handling, so a
Chrome crash mid-scrape left the dead handle cached and every subsequent page
load failed against it. Fixed, with the same identity guards and the same
seam. This is a bug fix, not a testing improvement.

A caller overriding `launch` owns the isolation arguments too — the renderer's
defaults are its security posture, not a convenience.
