import { Suspense, lazy } from "react";

/**
 * The two secondary surfaces, loaded on first use.
 *
 * Chat is what the app opens on; the graph (which drags in sigma and
 * graphology) and the activity record are reached from the rail, often never in
 * a given session. Splitting them keeps their code out of the bundle that has
 * to arrive before anything can be shown.
 *
 * The Suspense boundary lives here rather than in the consuming shell so these
 * stay drop-in components: the shell renders <GraphPage /> exactly as before
 * and does not have to know that it suspends. The fallback is deliberately
 * empty — the chunk resolves in a frame or two on any warm cache, and a
 * spinner that flashes for one frame reads as a glitch rather than as progress.
 */
const GraphPageLazy = lazy(() =>
  import("./components/graph/graph-page.js").then((m) => ({ default: m.GraphPage }))
);

const ActivityPageLazy = lazy(() =>
  import("./components/activity/activity-page.js").then((m) => ({
    default: m.ActivityPage,
  }))
);

export function GraphPage() {
  return (
    <Suspense fallback={null}>
      <GraphPageLazy />
    </Suspense>
  );
}

export function ActivityPage() {
  return (
    <Suspense fallback={null}>
      <ActivityPageLazy />
    </Suspense>
  );
}
