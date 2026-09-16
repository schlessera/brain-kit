---
"@schlessera/brain-ui-kit": patch
---

ui-kit: fix a graph that rendered as a line and a lane drawn as two runs.

`GraphView` renders every element inside it absolutely, so its intrinsic width
is zero and `width: 100%` in a container that sizes itself to its content
resolved against a container waiting for the same number. Both landed on nothing
and the graph collapsed to a 2px sliver of its own border. It now carries a
`minWidth` floor: below it eight labelled nodes pile into an unreadable heap, so
a narrow graph is the correct failure and an invisible one never is.

`LaneChart` gave every segment a radius on all four corners, so a lane whose
segments touch — one piece of work that stopped being able to continue — drew
the solid cap and the hatched cap rounding away from each other with a notch
between them, reading as two separate runs. Since the hatch means *waiting on
the user* and that distinction is the only argument the chart makes, the seam
was working against the component. A continuation now drops its left rounding,
reaches back under its predecessor by one corner radius, and paints behind it.
