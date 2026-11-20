---
"@schlessera/brain-ui-server": patch
---
Scrub up to 64 journal-store directory entries per idle maintenance pass, quarantining verified orphan files while retaining their quota charge and reporting counts, skips and integrity failures in maintenance Activity.
