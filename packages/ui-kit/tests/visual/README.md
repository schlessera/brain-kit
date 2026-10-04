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
target and native edge taps through the pending states at 240px, 320px and desktop
container widths. It separately checks compact paint, border-free transparent
expansion, card containment and non-overlapping targets, including Undo and
wrapped action rows. The default runner and
CI include this project; scoped direct invocations use `--project=visual` plus
`--project=rank-footer-touch`. Separate contexts keep touch media queries from
changing the fine-pointer hint cases.

`track-intake.visual.tsx` gives each mixed picker its own `navigator.onLine`
descriptor and restores the previous descriptor in `finally`. Connected cases
start from a deliberately offline sentinel; separate offline cases retain a
mixed draft without multipart requests, then resume through the actual Composer
online event. A failure sentinel checks descriptor restoration after an exception.
Both picker widths retain image decoding, held-send and nonempty multipart
assertions. Original File references are saved before Composer clears the live
picker FileList, so offline input evidence remains available after processing.
Review captures stay in `.vitest-attachments/track-intake/`; no
product connectivity policy or matrix-wide online override is involved.

The dictation height-cap checks wait for the phone entrance animation to finish
and require an identity transform before comparing the exact rendered height.
Chromium can round translated rect edges independently while the layout box
still obeys its cap. The regression replays a measured translating frame; the
60vh/32rem limits, motion coverage and newest-word scrolling checks remain exact.
