---
"@schlessera/brain-ui-kit": minor
---

ui-kit wave 4: agent views, screen chrome and the first desktop components.

Thirteen components, taking the kit to 59. Agent and corpus views —
`AgentRunCard`, `AgentOrbit`, `LaneChart`, `GraphView`. Screen chrome —
`ScreenHeader`, `ScreenBody`, `Composer`, `TabBar`, `BottomSheet`,
`MessageBubble`. Desktop, per D22 — `SideRail` and `CommandPalette`, the first
components in the kit built for a window rather than a phone.

Three of those are not straight ports and each is documented where it lives:

- **`Composer` is now a real `<textarea>`.** The design draws it as a styled
  span and its own known-gaps list asks for the input; ⏎ sends, ⇧⏎ inserts a
  newline, and with no `onChange` the field is genuinely `readOnly` rather than
  a div wearing `role="textbox"`.
- **`ScreenBody` is the kit's one addition to the design's component set.**
  Every assembled screen retypes the same `flex: 1; min-height: 0; overflow`
  container by hand, and a body missing `min-height: 0` does not scroll, it
  grows.
- **`AgentRunCard` takes `agent`, not `name`.** The source's `data-props`
  declares `name` while its own `renderVals()` reads `p.agent`; the half that
  renders wins.

`AgentOrbit`'s polar placement is verified numerically against hand-computed
pixel values, the way `MapView`'s projection was. `TabBar`'s expanded hit target
is measured rather than described, including the bar width below which its slots
begin stealing each other's clicks.

34 new tokens. Three runtime fallbacks that named a real brand or a real person
were replaced with the fixture world's content; every other fallback is the
design's verbatim, so it stays comparable against the source.
