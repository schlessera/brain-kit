---
"@schlessera/brain-ui-kit": minor
---

New storage history components (#4543).

- **`HistoryChart`** draws available space over time for one volume as hand-rolled SVG: Low and Very low bands with `△`/`▲` labels, gaps as hatched breaks labelled "no observation · not zero" (never drawn as zero), the current bucket as a hollow provisional point, a `now` rule and value, and one dashed line per qualified scenario window, with no cone between them. With no qualified window the caption says why. A scope change is a solid rule with the earlier volume drawn mute and never joined. Numbered event markers take a generic `{ at, n, tone, label }` and merge into one box only when they would collide. From 600px the scenario labels sit in a right gutter; below that the caption repeats each line's dash with its copy. The SVG is one `role="img"` with a summary name, and `View as table` discloses the equivalent table, which is the screen-reader path.
- **`EventList`** is the numbered legend matching the chart's markers.
- **`Sparkline`** is a small gap-preserving line with an end value label, or a mute `?` when nothing was measured.
- **`projectionReasonText`** returns the approved "no projection ·" copy for each history evidence reason.

All take data and formatters as props; none fetches or uses a wire type.
