# Destination paint reference control (#1938)

These are immutable diagnostic captures, not baselines to regenerate.

`original/` retains the four unmodified PNGs and state from automatic run
38627076350, attempt 1, browser job 116069242617, artifact 11925821879.
Its checkout is `fa04431d9a56c4cde055e7ef1b9131f7f807633c`, parents
`155dffdd8237a1543da3109f3de0b659cfac5c93` and
`62bb93ee1e5564e6c34009209d359ed5cc41b8cc`, tree
`40dc40448c967f5d83bd345feb3ed39483d175cb`. The coarse-pointer dark-320 Files
comparison at 150ms is coherent within each state but differs at crop (244,39):
painted RGBA (26,22,25,255), hidden (20,22,25,255).

`control/` comes from a pinned local execution of that exact failed checkout,
with diagnostics added only after the original four comparisons. The fine
pointer reproduces the same one-pixel difference (416 passes / 1 failure).
Restoring visibility restores the original crop. Keeping visibility intact and
setting only the destination group's opacity to zero leaves every navigation
pixel identical to the painted crop; restoring opacity also leaves it identical.
Each control has a repeated capture, and all within-state pairs match exactly.
`control.json` records these byte comparisons. Raw `state.json` is collected
after the comparisons and is not capture-instant state evidence.

The opacity-only reference also failed on a fresh execution of this exact
checkout, so the warmed control alone is not a correction receipt. The selected
correction retains the original visible/hidden comparison and temporarily
promotes the fixed navigation with `translateZ(0)`, restoring its inline transform
in `finally`. No navigation geometry or z-index changes. A source-bound control
that removes only promotion while preserving the same reads, awaits and cleanup
reproduces the one-pixel Files mismatch (416 passes / 1 failure, mixed pointer).
The promoted exact-source matrix passes all 417 cases. This establishes the
rendering-layer condition; no internal Chromium cache mechanism is attributed.

With the corrected capture, overriding destination clipping to visible still
fails all 12 paint matrix cells on real shading (405 passes / 12 failures).
Within-state captures remain coherent. The original no-overlap guard, exact
comparison, motion, safe area and pointer/theme/width matrix remain intact.
No tolerance, pixel mask or baseline update is used.

`unpromoted/` retains the four captures/state from the control that omits only
promotion, on the same failed checkout. `promoted/` retains the restored
capture on that checkout. The source helper, original test order, pinned image,
fonts and all matrix inputs stay fixed between these two runs. The former fails
the mixed-pointer dark-320 Files comparison at 150ms; the latter passes all 417
cases. The promoted state records the navigation at (0,706,320,94), fixed at
z-index 30, while the destination remains fixed at z-index 40.
