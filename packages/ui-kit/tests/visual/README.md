# Visual baselines

`*-chromium-linux.png` in `__screenshots__/`, generated and compared **inside
`mcr.microsoft.com/playwright:v1.63.0-noble`** and nowhere else. Regenerate with
`bun run visual:update` from the repo root; never commit a baseline produced by
a host run. See `tests/visual/subjects.visual.tsx` for why, and which stories are
in the set.

The ranking-footer regression renders the real five-item story with the three
preview font families from `scripts/captures/font-lock.json`. `scripts/visual.mjs`
prepares the pinned public font files and original notices outside the browser,
then mounts that checksum-verified cache read-only. CI prepares the same inputs
before `--inside`; tests never download them. Direct offline container invocations
must mount the cache prepared by `bun run capture:fonts` under the same
`/tmp/brain-kit-feature-capture-fonts/` path. Existing subjects retain their font
setup; the ranking-footer test removes its font stylesheet afterward.

The named readability assertion measures each complete keyboard phrase's text
rectangles after a real fine-pointer reorder. It also checks Reset/Undo and
picked-up/cancelled states, keyboard movement and contained actions. Review
captures are written to `.vitest-attachments/rank-footer/`; changed-state
baselines cover phone and desktop, in dark and paper themes.

The `rank-footer-touch` project isolates a Chromium context with `hasTouch: true`.
It verifies coarse-pointer media queries, all four corners of each 44px action
target and native edge taps through the pending states. The default runner and
CI include this project; scoped direct invocations use `--project=visual` plus
`--project=rank-footer-touch`. Separate contexts keep touch media queries from
changing the fine-pointer hint cases.
