---
"@schlessera/brain-module-diagrams": minor
---
Diagram routes adapt to where their boxes and the other routes are. Ports on a side are ordered by where each edge goes. Sides change when that avoids a crossing, and crossing another route now costs more than a detour. Outer routes nest around inner ones. A fan-out through a section that crossed itself 8 times now has no crossings.

Routes keep 16px from a section's outline. Every `size: fit` image keeps a uniform 12px margin around everything drawn. On a named canvas, routes keep that margin, and `brain diagram check` warns with the new `margin` code about a node or group closer than 12px to the canvas edge.
