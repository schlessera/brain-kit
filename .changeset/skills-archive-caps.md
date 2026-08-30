---
"@schlessera/brain-ui-server": minor
---

Skill archive caps raised to 100 MB compressed / 250 MB inflated (was
20 / 50) — a repository of image-heavy skills no longer fails to install
from GitHub. The raise is safe because decompression is now streaming:
the per-file and total-inflated caps trip while bytes inflate, and the
zipball download aborts as soon as the body passes the compressed cap,
so a zip bomb can no longer materialize in memory before any check runs.
