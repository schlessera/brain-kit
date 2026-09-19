import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import { communityColor } from "./lib/graph-helpers.js";
import { NodeCard } from "./node-card.js";
import { useGraphTheme } from "./use-graph-theme.js";
import { useNodeActions } from "./use-node-actions.js";

/**
 * Detail card for the selected node, docked to the bottom-left of the canvas
 * (bottom sheet width on phones). From `wide:` the D6 right rail draws the
 * node instead and `SceneBody` does not mount this.
 *
 * This is the container (S7): the store reads and the "which actions
 * apply" rules (`useNodeActions`) live here; `NodeCard` draws the card on
 * the kit.
 */
export function NodePopover({
  node,
  communityLabel,
}: {
  node: GraphNodePayload;
  communityLabel?: string | null;
}) {
  const actions = useNodeActions(node);
  const theme = useGraphTheme();
  const isVirtual = node.virtual === true;

  return (
    <NodeCard
      kind={isVirtual ? "root" : node.type}
      title={node.title || node.path}
      path={node.path}
      topic={communityLabel}
      topicColor={node.community !== undefined ? communityColor(node.community, theme.palette) : undefined}
      inDegree={node.inDegree}
      outDegree={node.outDegree}
      distance={node.distance}
      canOpen={actions.canOpen}
      canFocus={actions.canFocus}
      canExpand={actions.canExpand}
      onOpen={actions.open}
      onFocus={actions.focus}
      onExpand={actions.expand}
      onClose={actions.close}
    />
  );
}
