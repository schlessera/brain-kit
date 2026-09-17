---
"@schlessera/brain-ui-react": patch
---

Bind model settings and pi account flows to their UI root. Preserve queued model
write ordering across root switches, reject stale catalog and login responses,
and stop cancelled or inactive login polls from replacing a newer flow.
