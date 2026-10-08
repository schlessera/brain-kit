# Visual baselines

`*-chromium-linux.png` in `__screenshots__/`, generated and compared **inside
`mcr.microsoft.com/playwright:v1.63.0-noble`** and nowhere else. Regenerate with
`bun run visual:update` from the repo root; never commit a baseline produced by
a host run. See `tests/visual/subjects.visual.tsx` for why, and which stories are
in the set.

Every browser project loads the three design font families from
`scripts/captures/font-lock.json` through `design-font-setup.ts` before rendering.
The shared setup waits for every locked weight/style, then checks Chromium's
actual painted glyph faces through CDP. Before and after each test it checks
that the verified stylesheet and registered face manifest remain intact: local
aliases and duplicate font stylesheets are rejected. RecordingRow additionally
checks the actual timestamp/status faces before each screenshot.

`scripts/visual.mjs`
prepares the pinned public font files and original notices outside the browser,
then mounts that checksum-verified cache read-only. CI prepares the same inputs
before `--inside`; tests never download them. Direct offline container invocations
must mount the cache prepared by `bun run capture:fonts` under the same
`/tmp/brain-kit-feature-capture-fonts/` path. Tests use no installed-font stand-ins.
The host's mono source supplies weights 400–600; weight 700 uses Chromium's
synthesis from that real face, matching the existing preview source.

Regenerate the complete affected matrix with `node scripts/visual.mjs --update`.
`bun run visual:update` selects only `visual` and `subjects`; isolated dictation,
module Settings, ranking touch and mixed-pointer rail snapshots must also be
included when their font inputs change. Keep existing viewport/pointer/theme
matrices, baseline names and tolerances. See
[the font decision](../../../../docs/decisions/visual-fonts.md).

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

The complete `dictation-panel.visual.tsx` file runs in the `dictation` project,
with its own Playwright provider/page lifetime. Its desktop, motion and capture
cases precede touch emulation, which Chromium does not reliably undo to a fine
pointer. The shared `visual` project excludes this file and has no dictation
emulation commands. `bun run test:browser` and both CI shards include the project;
scope it with `--project=dictation`. Fixture cleanup restores document, viewport
and motion state through failure paths. The intentional renderer-failure case
records real pointer media state after releasing touch; it does not claim that
disabling touch restores a fine pointer. Runtime boundary proof must retain
dictation-before-ranking order and a reused visual page; isolated/ranking-first
passes alone do not verify #878, nor diagnose #879's screenshot differences.

`session-strip.visual.tsx` runs in the three `rail-*` pointer projects, beside
the rail's targets, so every geometry, focus and corner-hit case is checked with
fine, coarse and mixed pointers under reduced motion. Its pixel baselines are
taken in `rail-mixed` only; regenerate them with
`node scripts/visual.mjs --project=rail-mixed --update`. The fine and coarse
runs write review captures to `.vitest-attachments/session-strip/` instead.
