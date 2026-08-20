---
"@schlessera/brain-ui-react": patch
---

Open the graph view in Clusters instead of Local.

Local mode is centred on a single node and has no center until the user picks
one, so opening the graph landed on an empty canvas with a picker — which reads
as "the graph is broken", not as "choose a starting point". Clusters answers
the question someone opening a graph view is actually asking: what is in here,
and what clumps together.

Local is still one click away, and clicking any node switches to it — that is
the natural way in, rather than the landing state.

One consequence worth knowing: Local is exempt from the "needs precomputed
graph tables" gate, so a repo whose graph has never been computed now lands on
the "Graph not built yet" panel rather than an empty Local canvas. That is the
more honest of the two — it names the problem and gives the command to fix it.
