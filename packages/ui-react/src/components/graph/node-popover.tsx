import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import { useFileStore } from "../../stores/file-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useGraphStore } from "../../stores/graph-store.js";
import { communityColor } from "./lib/graph-helpers.js";
import { NodeCard } from "./node-card.js";

/**
 * Detail card for the selected node, docked to the bottom-left of the canvas
 * (bottom sheet width on phones). "Open note" hands over to the file viewer
 * panel — the same hand-off the search modal uses.
 *
 * This is the container (S7): the store reads and the "which actions
 * apply" rules live here; `NodeCard` draws the card on the kit.
 */
export function NodePopover({
  node,
  communityLabel,
}: {
  node: GraphNodePayload;
  communityLabel?: string | null;
}) {
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const mode = useGraphStore((s) => s.mode);
  const select = useGraphStore((s) => s.select);
  const setMode = useGraphStore((s) => s.setMode);
  const setLocalParams = useGraphStore((s) => s.setLocalParams);
  const expandNode = useGraphStore((s) => s.expandNode);

  const isVirtual = node.virtual === true;

  function handleOpen() {
    setFilePanelOpen(true);
    void openFile(node.path);
  }

  function handleFocus() {
    // Re-center the local view on this node (switching mode when needed).
    if (mode !== "local") setMode("local");
    setLocalParams({ center: node.path });
    select(null);
  }

  return (
    <NodeCard
      kind={isVirtual ? "root" : node.type}
      title={node.title || node.path}
      path={node.path}
      topic={communityLabel}
      topicColor={node.community !== undefined ? communityColor(node.community) : undefined}
      inDegree={node.inDegree}
      outDegree={node.outDegree}
      distance={node.distance}
      canOpen={!isVirtual}
      canFocus={!isVirtual && (mode !== "local" || node.distance !== 0)}
      canExpand={mode === "local" && !isVirtual && node.distance !== 0}
      onOpen={handleOpen}
      onFocus={handleFocus}
      onExpand={() => void expandNode(node.path)}
      onClose={() => select(null)}
    />
  );
}
