import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import { useFileStore } from "../../stores/file-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useGraphStore } from "../../stores/graph-store.js";

/**
 * The "which actions apply to the selected node" rules, shared by the
 * floating `NodePopover` (below `laptop:`) and the D6 right rail (from
 * `wide:`). Both draw the same node; only the surface differs, so the rules
 * live once.
 *
 * - Open note hands over to the file viewer panel — the same hand-off the
 *   search modal uses. Never for a virtual root (no file behind it).
 * - Focus here re-centres the Local view on the node, switching mode when
 *   needed; pointless on the node that already is the centre.
 * - Expand pulls the node's depth-1 ego into the scene — Local only, and
 *   not for the centre (its ego is the scene).
 */
export function useNodeActions(node: GraphNodePayload) {
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const mode = useGraphStore((s) => s.mode);
  const select = useGraphStore((s) => s.select);
  const setMode = useGraphStore((s) => s.setMode);
  const setLocalParams = useGraphStore((s) => s.setLocalParams);
  const expandNode = useGraphStore((s) => s.expandNode);

  const isVirtual = node.virtual === true;

  return {
    canOpen: !isVirtual,
    canFocus: !isVirtual && (mode !== "local" || node.distance !== 0),
    canExpand: mode === "local" && !isVirtual && node.distance !== 0,
    open() {
      setFilePanelOpen(true);
      void openFile(node.path);
    },
    focus() {
      if (mode !== "local") setMode("local");
      setLocalParams({ center: node.path });
      select(null);
    },
    expand() {
      void expandNode(node.path);
    },
    close() {
      select(null);
    },
  };
}

/** `${n} hop`/`${n} hops`, or null at the centre (0) and where unknown. */
export function hopsLabel(distance: number | undefined): string | null {
  if (distance === undefined || distance <= 0) return null;
  return `${distance} hop${distance === 1 ? "" : "s"}`;
}
