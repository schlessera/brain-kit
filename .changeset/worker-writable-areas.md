---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": patch
"@schlessera/brain": minor
---

Give hosted agent turns designed writable places again. The brain stays read-only inside the worker, but `.brain/scratch/` is now bound writable (created when missing, refused when redirected by a symlink or not gitignored), so `brain render --scratch`, `brain image --scratch` and `brain scratch prune` work in a turn and their output stays for the reader. An existing `workspaces/` directory is bound writable too, so repository clones can be fetched and committed; it stays read-only for a turn when it holds a file hard-linked to something outside it. `$HOME` gets a per-turn overlay on bubblewrap 0.11 or later, so tools such as headless Chromium can write their caches; elsewhere the XDG config, cache and data directories point at per-turn directories under `/tmp`. Every turn's agent now reads a generated note saying which of these it has and to link only files in `.brain/scratch/`. The `brain` CLI's read-only refusals for `render` and `image` name `--scratch` as the route, and the file routes never follow a symlink under the scratch area. Autonomous turns are unchanged.
