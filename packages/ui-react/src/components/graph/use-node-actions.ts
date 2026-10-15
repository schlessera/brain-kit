import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import { useFileStore } from "../../stores/file-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useGraphStore } from "../../stores/graph-store.js";
import { useBrainUiRoot } from "../../root-context.js";
import { DISCOVERY_MAX_DEPTH } from "../../lib/discovery-expansion.js";

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
 * - Local Expand pulls a non-centre note's depth-1 ego into the scene.
 * - Discovery Expand reveals supported outgoing targets from original-root
 *   evidence; loading, counts and reasons come from the root-owned controller.
 */
export function useNodeActions(node: GraphNodePayload) {
  const root = useBrainUiRoot();
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const mode = useGraphStore((s) => s.mode);
  const select = useGraphStore((s) => s.select);
  const setMode = useGraphStore((s) => s.setMode);
  const setLocalParams = useGraphStore((s) => s.setLocalParams);
  const expandNode = useGraphStore((s) => s.expandNode);
  const expansion = useGraphStore(s => s.discoveryExpansion);
  const expansionFor = useGraphStore(s => s.discoveryExpansionFor);
  const expansionAction = mode === "discovery" ? expansionFor(node) : null;

  const isVirtual = node.virtual === true;

  return {
    canOpen: !isVirtual,
    canFocus: !isVirtual && (mode !== "local" || node.distance !== 0),
    canExpand: !isVirtual && (mode === "discovery"
      ? node.distance !== undefined && node.distance >= 0 && node.distance <= DISCOVERY_MAX_DEPTH
      : mode === "local" && node.distance !== 0),
    expandLoading: expansionAction?.loading ?? false,
    expandDisabled: expansionAction ? !expansionAction.enabled && !expansionAction.loading : false,
    expandReason: expansionAction?.error ?? expansionAction?.reason,
    expandError: expansionAction?.error,
    expandNeedsRefresh: expansionAction?.needsRefresh,
    expandLabel: expansionAction?.loading ? "Expanding…" : expansionAction?.count
      ? `Expand · ${expansionAction.count} note${expansionAction.count === 1 ? "" : "s"}` : "Expand",
    expandName: mode === "discovery" ? `Expand ${node.title || node.path}${expansionAction?.count ? `, ${expansionAction.count} note${expansionAction.count === 1 ? "" : "s"} not shown` : ""}` : undefined,
    expansionChoices: expansion.intents.length,
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
    retry() {
      if (!expansionAction?.needsRefresh) { void expandNode(node.path); return; }
      const before = root.stores.graph.getState();
      void (async () => {
        await before.fetchMeta(true);
        const current = root.stores.graph.getState();
        if (current.mode !== before.mode || current.discovery.root !== before.discovery.root || current.discovery.maxDepth !== before.discovery.maxDepth) return;
        await current.fetchScene();
      })();
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
