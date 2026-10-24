---
"@schlessera/brain-ui-server": patch
---

Count the brain's disposable search index once per turn at its largest observed size, and stop counting its publication copies once they are gone, so a strict pi turn's host-applied edits no longer pause on the `turn_bytes` scope cap because each index refresh was charged in full.
