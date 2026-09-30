---
"@schlessera/brain": minor
---

Breaking: configuration loading now rejects `exclude.files` entries ending in `/`; replace `files: ["drafts/"]` with `dirs: ["drafts"]` to exclude the directory. Directory checks ignore exact-file rules, keeping stats consistent with indexing and preventing OKF output from remaining indexable.
