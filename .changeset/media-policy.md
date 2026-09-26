---
"@schlessera/brain": minor
---

Media gets a decision before it is committed.

- `brain sync assess` has two new classes: `MEDIA` for an image, PDF, audio, video or office file, and `LARGE` for any file over `media.maxTrackedBytes` (default 5 MiB). Both carry their size in `bytes`. Before, these files came back `UNKNOWN`. `*.pptx` is no longer an automatic `ARTIFACT`; a presentation is media.
- A new `media` block in `brain.config.ts` sets the limit, plus `track` and `ignore` globs that settle a file once and for all (`ignore` wins).
- The `/sync` skill asks before tracking a `MEDIA` or `LARGE` file and offers an ignore glob or Git LFS. An unattended sync leaves such files untouched and reports them.
- A new `brain doctor` check, `tracked-media`, lists the five largest tracked binaries and warns when a tracked file is over the limit. It measures the blobs in git's index, counts Git LFS pointers and symlinks as what git stores, and warns when it cannot inspect an object.
- The template `.gitignore` gains a commented media section, and `docs/media.md` explains what belongs in git.
