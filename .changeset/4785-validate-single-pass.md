---
"@schlessera/brain": patch
---

`brain validate`, and every hygiene detection, `brain audit --fix` and hygiene repair post-check that runs it, reads and parses each markdown file once instead of twice (#4785). Link and `supersedes` checks still run once every file's aliases are known, and the issues, their order and `brain validate --json` are unchanged. A file that cannot be read still stops the run with its error. The aliases, `supersedes` values and link targets kept until the end of the run are copies, so they no longer keep each file's whole text in memory.
