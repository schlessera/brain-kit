import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { expect, waitFor } from "storybook/test";
import preview from "#.storybook/preview";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { GraphPage } from "../../../ui-react/src/components/graph/graph-page.js";
import type { GraphMode } from "../../../ui-react/src/stores/graph-state.js";
import consumerStyles from "../../../ui-react/dist/styles.css?raw";
import { notes } from "../../fixtures/notes.js";

/** Actual consumer page and stylesheet, isolated from the kit's spacing.
 * The layout suite renders this state at real 320/1280 browser viewports in
 * both themes; this story follows the preview viewport and offers every mode. */
function GraphUnavailable({ mode }: { mode: GraphMode }) {
  const mount = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [root] = useState(() => {
    const root = createBrainUiRoot({ storage: null, request: async () => Response.json({ error: "graph_unavailable", reason: "core_unavailable" }, { status: 503 }) });
    root.stores.graph.setState({ mode, local: { center: notes[0]!.path, depth: 1, direction: "both" } });
    return root;
  });
  useEffect(() => {
    setShadow(mount.current!.shadowRoot ?? mount.current!.attachShadow({ mode: "open" }));
    return () => root.dispose();
  }, [root]);
  useEffect(() => { root.stores.graph.getState().setMode(mode); }, [root, mode]);
  return <div ref={mount} data-graph-unavailable-preview style={{ width: "100%", height: 760 }}>{shadow ? createPortal(<>
    <style>{consumerStyles}</style>
    <div style={{ display: "flex", height: "100%" }}><BrainUiProvider root={root}><GraphPage /></BrainUiProvider></div>
  </>, shadow) : null}</div>;
}

const meta = preview.meta({
  title: "Conversation/Graph unavailable", component: GraphUnavailable,
  parameters: { layout: "fullscreen" }, args: { mode: "clusters" },
  argTypes: { mode: { control: "select", options: ["clusters", "discovery", "local", "maintenance"] } },
});
export const Clusters = meta.story({ args: { mode: "clusters" }, play: async ({ canvasElement }) => {
  await waitFor(() => expect(canvasElement.querySelector('[data-graph-unavailable-preview]')?.shadowRoot?.querySelector('h2')?.textContent).toBe("Graph unavailable on this server"));
  const shadow = canvasElement.querySelector('[data-graph-unavailable-preview]')!.shadowRoot!;
  await expect(shadow.querySelector('canvas')).toBeNull();
  await expect(shadow.querySelector('[aria-label="Selected node"]')).toBeNull();
} });
export const Discovery = Clusters.extend({ args: { mode: "discovery" } });
export const Local = Clusters.extend({ args: { mode: "local" } });
export const Maintenance = Clusters.extend({ args: { mode: "maintenance" } });
