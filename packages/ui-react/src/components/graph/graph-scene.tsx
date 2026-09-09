import { Suspense, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  List,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  GraphMaintenanceResponse,
  GraphNodePayload,
} from "@schlessera/brain-ui-sdk/protocol";

import { useGraphStore } from "../../stores/graph-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useFileStore } from "../../stores/file-store.js";
import { apiBase } from "../../lib/backend.js";
import { GraphControls } from "./graph-controls.js";
import { NodePopover } from "./node-popover.js";
import { GraphEmptyState, Mono } from "./graph-empty-state.js";
import { GraphCanvas } from "./graph-canvas-lazy.js";
import { CenteredSpinner } from "./graph-spinner.js";
import {
  OTHER_COLOR,
  assignFolderColors,
  buildQuery,
  communityColor,
  distanceColor,
  groupCommunities,
  matchScene,
  topLevelDir,
} from "./lib/graph-helpers.js";
import { useGraphTheme } from "./use-graph-theme.js";
import { cn } from "../../lib/utils.js";

/** Client force layout is a fallback for repos whose FA2 layout was skipped —
 * beyond this it would freeze the tab, so we refuse and say why. */
const CLIENT_LAYOUT_NODE_CAP = 2000;

/** The canvas plus everything overlaid on it. Only mounts with data present. */
export function SceneBody() {
  const mode = useGraphStore((s) => s.mode);
  const meta = useGraphStore((s) => s.meta);
  const subgraph = useGraphStore((s) => s.subgraph)!;
  const selectedId = useGraphStore((s) => s.selectedId);
  const hoveredId = useGraphStore((s) => s.hoveredId);
  const select = useGraphStore((s) => s.select);
  const hover = useGraphStore((s) => s.hover);
  const sceneQuery = useGraphStore((s) => s.sceneQuery);
  const clustersSizeBy = useGraphStore((s) => s.clustersSizeBy);
  const discoveryColorBy = useGraphStore((s) => s.discoveryColorBy);
  const theme = useGraphTheme();
  const [listOpen, setListOpen] = useState(false);

  const matchIds = useMemo(
    () => matchScene(subgraph.nodes, sceneQuery),
    [subgraph.nodes, sceneQuery]
  );

  const layout =
    mode === "clusters"
      ? subgraph.nodes.some((n) => n.x !== undefined)
        ? ("fixed" as const)
        : ("force" as const)
      : mode === "discovery"
        ? ("radial" as const)
        : ("force" as const);

  const maxDistance = useMemo(
    () => Math.max(1, ...subgraph.nodes.map((n) => n.distance ?? 0)),
    [subgraph.nodes]
  );

  const folderColors = useMemo(
    () =>
      mode === "discovery" && discoveryColorBy === "folder"
        ? assignFolderColors(subgraph.nodes.map((n) => n.path))
        : null,
    [mode, discoveryColorBy, subgraph.nodes]
  );

  const nodeColor = useMemo(() => {
    if (mode === "discovery") {
      if (folderColors) {
        return (node: GraphNodePayload) =>
          node.virtual
            ? theme.nodeSelected
            : (folderColors.get(topLevelDir(node.path)) ?? OTHER_COLOR);
      }
      return (node: GraphNodePayload) =>
        node.virtual ? theme.nodeSelected : distanceColor(node.distance ?? maxDistance);
    }
    return (node: GraphNodePayload) =>
      node.community !== undefined ? communityColor(node.community) : theme.node;
  }, [mode, folderColors, maxDistance, theme]);

  const centerId = useMemo(
    () =>
      mode === "local"
        ? (subgraph.nodes.find((n) => n.distance === 0)?.id ?? null)
        : null,
    [mode, subgraph.nodes]
  );

  const edgeColor = useMemo(() => {
    if (mode !== "local" || centerId === null) return undefined;
    // Backlinks into the center get the accent so in/out reads at a glance.
    return (edge: { source: number; target: number }) =>
      edge.target === centerId ? theme.edgeHighlight : undefined;
  }, [mode, centerId, theme]);

  const selectedNode = useMemo(
    () =>
      selectedId === null
        ? null
        : (subgraph.nodes.find((n) => n.id === selectedId) ?? null),
    [selectedId, subgraph.nodes]
  );

  const communityLabel =
    selectedNode?.community !== undefined
      ? (meta?.communities.find((c) => c.community === selectedNode.community)
          ?.label ?? null)
      : null;

  // Clusters whose FA2 layout was skipped at index time: client force layout
  // is a bounded courtesy. Over the cap, only the canvas is replaced — the
  // legend and controls stay live so filtering to one topic (a subset under
  // the cap) still works.
  const layoutBlocked =
    mode === "clusters" &&
    layout === "force" &&
    subgraph.nodes.length > CLIENT_LAYOUT_NODE_CAP;

  return (
    <>
      {layoutBlocked ? (
        <GraphEmptyState icon="warn" title="Too large to lay out here">
          The cluster layout was skipped at index time (corpus over the layout
          cap), and {subgraph.nodes.length.toLocaleString()} notes are too many
          to arrange in the browser. Pick a topic from the legend to view a
          subset.
        </GraphEmptyState>
      ) : (
        <Suspense fallback={<CenteredSpinner />}>
          <GraphCanvas
            data={subgraph}
            layout={layout}
            selectedId={selectedId}
            hoveredId={hoveredId}
            matchIds={matchIds}
            sizeBy={mode === "clusters" ? clustersSizeBy : "degree"}
            rings={mode === "discovery" ? maxDistance : 0}
            nodeColor={nodeColor}
            edgeColor={edgeColor}
            onSelect={select}
            onHover={hover}
          />
        </Suspense>
      )}

      <GraphControls />

      {mode === "clusters" && <ClusterLegend />}
      {mode === "discovery" && folderColors && (
        <FolderLegend colors={folderColors} />
      )}
      {mode === "discovery" && (
        <UnreachableTray count={subgraph.unreachableCount} />
      )}

      {/* Accessible / mobile-friendly node list — the canvas itself is aria-hidden */}
      <button
        onClick={() => setListOpen((v) => !v)}
        className="absolute bottom-3 right-3 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface-overlay text-foreground shadow-lg"
        title="Node list"
        aria-expanded={listOpen}
      >
        <List className="h-4.5 w-4.5" />
      </button>
      {listOpen && <NodeList onClose={() => setListOpen(false)} />}

      {selectedNode && (
        <NodePopover node={selectedNode} communityLabel={communityLabel} />
      )}
    </>
  );
}

/** Clusters mode: interactive community legend, top-left. */
function ClusterLegend() {
  const meta = useGraphStore((s) => s.meta);
  const clusters = useGraphStore((s) => s.clusters);
  const setClustersParams = useGraphStore((s) => s.setClustersParams);
  const [collapsed, setCollapsed] = useState(false);

  const groups = useMemo(
    () => groupCommunities(meta?.communities ?? []),
    [meta?.communities]
  );
  if (groups.major.length === 0) return null;

  const shown = groups.major.slice(0, 8);
  const foldedCount =
    groups.major.length - shown.length + groups.singletonCount;

  return (
    <div className="absolute left-3 top-3 z-10 w-56 max-w-[calc(100vw-5rem)] rounded-xl border border-border bg-surface-overlay/95 shadow-xl backdrop-blur">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-foreground"
        aria-expanded={!collapsed}
      >
        Topics
        {collapsed ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      {!collapsed && (
        <div className="max-h-64 overflow-y-auto px-1 pb-2">
          {shown.map((c) => {
            const active = clusters.community === c.community;
            return (
              <button
                key={c.community}
                onClick={() =>
                  setClustersParams({ community: active ? null : c.community })
                }
                className={cn(
                  "flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors",
                  active ? "bg-surface-raised" : "hover:bg-surface-raised/60"
                )}
                title={
                  active
                    ? "Show all topics"
                    : `Show only this topic (${c.size} notes)`
                }
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: communityColor(c.community) }}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {c.label ?? `Topic ${c.community + 1}`}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {c.size}
                </span>
              </button>
            );
          })}
          {foldedCount > 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: OTHER_COLOR }}
              />
              <span className="text-[11px] text-muted-foreground">
                {foldedCount} smaller topic{foldedCount === 1 ? "" : "s"}
              </span>
            </div>
          )}
          {clusters.community !== null && (
            <button
              onClick={() => setClustersParams({ community: null })}
              className="mx-2 mt-1 flex min-h-8 items-center gap-1 rounded-lg bg-surface-raised px-2 py-1 text-[11px] text-foreground hover:bg-surface"
            >
              <X className="h-3 w-3" />
              Clear topic filter
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Discovery + color-by-folder: which top-level dir wears which color. */
function FolderLegend({ colors }: { colors: Map<string, string> }) {
  const entries = [...colors.entries()].filter(([, c]) => c !== OTHER_COLOR);
  const otherCount = colors.size - entries.length;
  if (entries.length === 0) return null;
  return (
    <div className="absolute left-3 top-3 z-10 w-48 rounded-xl border border-border bg-surface-overlay/95 px-3 py-2 shadow-xl backdrop-blur">
      <div className="mb-1 text-xs font-medium text-foreground">Folders</div>
      {entries.map(([dir, color]) => (
        <div key={dir} className="flex min-h-6 items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {dir || "(root)"}
          </span>
        </div>
      ))}
      {otherCount > 0 && (
        <div className="flex min-h-6 items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: OTHER_COLOR }}
          />
          <span className="text-[11px] text-muted-foreground">
            {otherCount} more
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Discovery: how much of the corpus this root does NOT reach. The count comes
 * from the server (`unreachableCount`) — a scene-size subtraction would lie
 * under depth limits, truncation, and the virtual root. An older server
 * doesn't send it; then the tray only appears for the default root, where the
 * maintenance findings still provide the exact list, and shows no number.
 */
function UnreachableTray({ count }: { count: number | undefined }) {
  const discovery = useGraphStore((s) => s.discovery);
  const staleDays = useGraphStore((s) => s.maintenance.staleDays);
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<GraphNodePayload[] | null>(null);

  const isDefaultRoot = !discovery.root;
  // Older server, no count field: the maintenance list is the only honest
  // source, so it must be fetched EAGERLY — the chip may only appear once
  // the list proves there is something to warn about.
  const needsFallbackProof = count === undefined && isDefaultRoot;

  useEffect(() => {
    const wanted = (open || needsFallbackProof) && isDefaultRoot;
    if (!wanted || nodes !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${apiBase()}/graph/maintenance?${buildQuery({ staleDays })}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as GraphMaintenanceResponse;
        if (!cancelled) setNodes(data.unreachable);
      } catch {
        // The tray degrades to count-only (or stays hidden in fallback mode).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, needsFallbackProof, isDefaultRoot, nodes, staleDays]);

  if (count === 0) return null;
  // No server count and no exact list available: nothing honest to show.
  if (count === undefined && !isDefaultRoot) return null;
  // Fallback mode: silent until the maintenance list confirms unreachable
  // notes exist — an unproven warning chip would cry wolf on clean repos.
  if (needsFallbackProof && (nodes === null || nodes.length === 0)) return null;

  return (
    <div className="absolute bottom-3 left-3 z-10 max-w-[calc(100vw-5rem)]">
      {open && (
        <div className="mb-2 flex max-h-56 w-64 flex-col overflow-hidden rounded-xl border border-border bg-surface-overlay/95 shadow-2xl backdrop-blur">
          <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
            {isDefaultRoot
              ? "Not reachable from the root:"
              : "Count only — pick the default root for the full list."}
          </div>
          {isDefaultRoot && (
            <div className="flex-1 overflow-y-auto">
              {(nodes ?? []).map((node) => (
                <button
                  key={node.id}
                  onClick={() => {
                    setFilePanelOpen(true);
                    void openFile(node.path);
                  }}
                  className="flex min-h-9 w-full flex-col justify-center px-3 py-1 text-left hover:bg-surface-raised/60"
                >
                  <span className="truncate text-xs text-foreground">
                    {node.title || node.path}
                  </span>
                </button>
              ))}
              {nodes === null && (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-surface-overlay px-3 py-1.5 text-[11px] text-muted-foreground shadow-lg transition-colors hover:text-foreground"
      >
        <TriangleAlert className="h-3 w-3" />
        {count !== undefined
          ? `${count} unreachable`
          : `${nodes!.length} unreachable`}
      </button>
    </div>
  );
}

/**
 * Discovery with no root at all (no entry file in the repo): make picking one
 * inviting — index notes are the natural candidates.
 */
export function DiscoveryStart() {
  const setDiscoveryParams = useGraphStore((s) => s.setDiscoveryParams);
  const [candidates, setCandidates] = useState<
    { path: string; title: string }[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${apiBase()}/brain/list?${buildQuery({ type: "index", limit: 6 })}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          results?: { path: string; title?: string }[];
        };
        if (!cancelled)
          setCandidates(
            (data.results ?? []).map((r) => ({
              path: r.path,
              title: r.title ?? r.path,
            }))
          );
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-surface px-8 py-10 text-center">
          <h2 className="font-display text-lg text-foreground">
            Where should discovery start?
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Discovery lays your notes out by how many links they are away from
            a starting point. This repo has no <Mono>AGENTS.md</Mono> entry
            file, so pick one — index notes work well:
          </p>
          {candidates === null ? (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {candidates.map((c) => (
                <button
                  key={c.path}
                  onClick={() => setDiscoveryParams({ root: c.path })}
                  className="flex min-h-10 flex-col justify-center rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-left transition-colors hover:border-primary/40"
                >
                  <span className="truncate text-xs text-foreground">
                    {c.title}
                  </span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground/60">
                    {c.path}
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            …or search any note in the options panel.
          </p>
        </div>
      </div>
      <GraphControls />
    </>
  );
}

/** Focusable listing of the current scene, sorted by connectedness. */
function NodeList({ onClose }: { onClose: () => void }) {
  const subgraph = useGraphStore((s) => s.subgraph)!;
  const select = useGraphStore((s) => s.select);
  const selectedId = useGraphStore((s) => s.selectedId);

  const sorted = useMemo(
    () =>
      [...subgraph.nodes].sort(
        (a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree)
      ),
    [subgraph.nodes]
  );

  return (
    <nav
      aria-label="Graph nodes"
      className="absolute bottom-16 right-3 z-10 flex max-h-[55dvh] w-72 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface-overlay/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-foreground">
          {sorted.length} note{sorted.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title="Close list"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.map((node) => (
          <button
            key={node.id}
            onClick={() => select(node.id)}
            className={cn(
              "flex min-h-11 w-full flex-col justify-center px-3 py-1.5 text-left transition-colors",
              node.id === selectedId
                ? "bg-surface-raised"
                : "hover:bg-surface-raised/60"
            )}
          >
            <span className="truncate text-xs text-foreground">
              {node.title || node.path}
            </span>
            <span className="truncate font-mono text-[10px] text-muted-foreground/60">
              {node.inDegree + node.outDegree} link
              {node.inDegree + node.outDegree === 1 ? "" : "s"} · {node.path}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
