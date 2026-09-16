# Visual baselines

`*-chromium-linux.png` in `__screenshots__/`, generated and compared **inside
`mcr.microsoft.com/playwright:v1.63.0-noble`** and nowhere else. Regenerate with
`bun run visual:update` from the repo root; never commit a baseline produced by
a host run. See `tests/visual/subjects.visual.tsx` for why, and which stories are
in the set.
