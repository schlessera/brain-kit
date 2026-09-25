---
"@schlessera/brain": minor
---

Media gets a decision before it is committed.

- `brain sync assess` has two new classes: `MEDIA` for an image, PDF, audio, video or office file, and `LARGE` for any file over `media.maxTrackedBytes` (default 5 MiB). Both carry their size in `bytes`. Before, both came back `UNKNOWN`.
- A new `media` block in `brain.config.ts` sets the limit, plus `track` and `ignore` globs that settle a file once and for all (`ignore` wins).
- The `/sync` skill asks before tracking a `MEDIA` or `LARGE` file and offers an ignore glob or Git LFS.
- A new `brain doctor` check, `tracked-media`, lists the five largest tracked binaries and warns when a tracked file is over the limit.
- The template `.gitignore` gains a commented media section, and `docs/media.md` explains what belongs in git.
