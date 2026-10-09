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
import { useBrainUiRoot } from "../../root-context.js";
import { GraphControls, WIDE_QUERY } from "./graph-controls.js";
import { NodePopover } from "./node-popover.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { GraphEmptyState, Mono } from "./graph-empty-state.js";
import { GraphCanvas } from "./graph-canvas-lazy.js";
import { CenteredSpinner } from "./graph-spinner.js";
import {
  assignFolderColors,
  buildQuery,
  communityColor,
  distanceColor,
  entityKind,
  entityLegend,
  groupCommunities,
  matchScene,
  topLevelDir,
  type CanvasPalette,
} from "../../lib/graph-helpers.js";
import { useGraphTheme, type EntityColors } from "./use-graph-theme.js";
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
  // From `wide:` the D6 right rail draws the selected node; the floating
  // card would double it.
  const wide = useMediaQuery(WIDE_QUERY);

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

  // The colouring rule (sixth pass §7) applies to the two modes drawn
  // around a focus node; Clusters IS the topic colouring. The focus node
  // (Discovery's root, Local's centre — distance 0, or the virtual root)
  // wears the amber of "the thing in focus" under every rule, as the kit's
  // `GraphView` draws it.
  const focused = mode === "discovery" || mode === "local";
  const rule = focused ? discoveryColorBy : "topic";

  // What the categorical legends describe: every node painted BY its category.
  // The focus node (the local centre, an explicit root, or a virtual node) is
  // painted amber whatever its type, folder or topic, so counting it under
  // one would make the legend disagree with the canvas.
  const legendNodes = useMemo(
    () => subgraph.nodes.filter((n) => !(n.virtual === true || (focused && n.distance === 0))),
    [subgraph.nodes, focused]
  );

  const folderColors = useMemo(
    () =>
      focused && rule === "folder"
        ? assignFolderColors(legendNodes.map((n) => n.path), theme.palette)
        : null,
    [focused, rule, legendNodes, theme.palette]
  );

  const nodeColor = useMemo(() => {
    const isFocus = (node: GraphNodePayload) => node.virtual === true || (focused && node.distance === 0);
    if (focused) {
      if (rule === "folder" && folderColors) {
        return (node: GraphNodePayload) =>
          isFocus(node)
            ? theme.nodeSelected
            : (folderColors.get(topLevelDir(node.path)) ?? theme.palette.other);
      }
      if (rule === "entity") {
        return (node: GraphNodePayload) =>
          isFocus(node) ? theme.entity.focus : entityColor(node.type, theme.entity);
      }
      if (rule === "topic") {
        return (node: GraphNodePayload) =>
          isFocus(node)
            ? theme.nodeSelected
            : node.community !== undefined
              ? communityColor(node.community, theme.palette)
              : theme.palette.other;
      }
      return (node: GraphNodePayload) =>
        isFocus(node) ? theme.nodeSelected : distanceColor(node.distance ?? maxDistance, theme.palette);
    }
    return (node: GraphNodePayload) =>
      node.community !== undefined ? communityColor(node.community, theme.palette) : theme.node;
  }, [focused, rule, folderColors, maxDistance, theme]);

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

      {/* The legend redraws per rule (sixth pass §7): it names what the
          canvas is doing right now, never a constant. */}
      {mode === "clusters" && <ClusterLegend palette={theme.palette} />}
      {focused && rule === "folder" && folderColors && (
        <FolderLegend colors={folderColors} other={theme.palette.other} />
      )}
      {focused && rule === "entity" && (
        <EntityLegend nodes={legendNodes} colors={theme.entity} />
      )}
      {focused && rule === "topic" && <TopicLegend nodes={legendNodes} palette={theme.palette} />}
      {focused && rule === "distance" && (
        <DistanceLegend maxDistance={maxDistance} focus={mode === "local" ? "centre" : "root"} palette={theme.palette} />
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

      {selectedNode && !wide && (
        <NodePopover node={selectedNode} communityLabel={communityLabel} />
      )}
    </>
  );
}

/** Clusters mode: interactive community legend, top-left. */
function ClusterLegend({ palette }: { palette: CanvasPalette }) {
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
                  style={{ backgroundColor: communityColor(c.community, palette) }}
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
                style={{ backgroundColor: palette.other }}
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

/** The kit's entity colour for a document type; neutral for the rest. */
function entityColor(type: string, colors: EntityColors): string {
  const kind = entityKind(type);
  return kind ? colors[kind] : colors.other;
}

/**
 * Colour-by-entity: the document types in the scene, the three entity kinds
 * in their kit colours first, every other type in the neutral ink under its
 * own name. The focus node is listed as what it is — amber, "focus" — so the
 * one node whose colour is not its type is accounted for.
 */
function EntityLegend({ nodes, colors }: { nodes: GraphNodePayload[]; colors: EntityColors }) {
  const rows = useMemo(() => entityLegend(nodes), [nodes]);
  return (
    <div
      className="absolute left-3 top-3 z-10 w-48 rounded-xl border border-border bg-surface-overlay/95 px-3 py-2 shadow-xl backdrop-blur"
      data-legend="entity"
    >
      <div className="mb-1 text-xs font-medium text-foreground">Entity type</div>
      <LegendRow color={colors.focus} label="focus" mono={false} />
      {rows.map((row) => (
        <LegendRow
          key={row.type}
          color={row.kind ? colors[row.kind] : colors.other}
          label={row.type}
          count={row.count}
        />
      ))}
    </div>
  );
}

/**
 * Colour-by-topic outside Clusters mode: read-only — the topic FILTER is
 * Clusters' own — listing the communities present in this scene. A corpus
 * with no computed topics says so rather than showing an empty box.
 */
function TopicLegend({ nodes, palette }: { nodes: GraphNodePayload[]; palette: CanvasPalette }) {
  const meta = useGraphStore((s) => s.meta);
  const rows = useMemo(() => {
    const counts = new Map<number, number>();
    for (const node of nodes) {
      if (node.community === undefined || node.virtual) continue;
      counts.set(node.community, (counts.get(node.community) ?? 0) + 1);
    }
    // The eight largest, folded past that like the cluster legend: a node
    // on the canvas whose colour has no row is a legend that lies by
    // omission. (Communities past the palette share the recessive colour anyway.)
    const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return { rows: all.slice(0, 8), folded: all.slice(8).reduce((n, [, c]) => n + c, 0), foldedTopics: Math.max(0, all.length - 8) };
  }, [nodes]);
  return (
    <div
      className="absolute left-3 top-3 z-10 w-48 rounded-xl border border-border bg-surface-overlay/95 px-3 py-2 shadow-xl backdrop-blur"
      data-legend="topic"
    >
      <div className="mb-1 text-xs font-medium text-foreground">Topics</div>
      {rows.rows.length === 0 ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          no topics computed · run <Mono>brain sync</Mono>
        </div>
      ) : (
        <>
          {rows.rows.map(([community, count]) => (
            <LegendRow
              key={community}
              color={communityColor(community, palette)}
              label={meta?.communities.find((c) => c.community === community)?.label ?? `Topic ${community + 1}`}
              count={count}
              mono={false}
            />
          ))}
          {rows.foldedTopics > 0 && (
            <LegendRow
              color={palette.other}
              label={`${rows.foldedTopics} smaller topic${rows.foldedTopics === 1 ? "" : "s"}`}
              count={rows.folded}
              mono={false}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Colour-by-distance: the amber focus, then the ramp one hop at a time. */
function DistanceLegend({ maxDistance, focus, palette }: { maxDistance: number; focus: "root" | "centre"; palette: CanvasPalette }) {
  const hops = Array.from({ length: Math.min(maxDistance, 5) }, (_, i) => i + 1);
  return (
    <div
      className="absolute left-3 top-3 z-10 w-48 rounded-xl border border-border bg-surface-overlay/95 px-3 py-2 shadow-xl backdrop-blur"
      data-legend="distance"
    >
      <div className="mb-1 text-xs font-medium text-foreground">Distance</div>
      <LegendRow color={distanceColor(0, palette)} label={focus} mono={false} />
      {hops.map((hop) => (
        <LegendRow
          key={hop}
          color={distanceColor(hop, palette)}
          label={hop === 5 && maxDistance > 5 ? `${hop}+ hops` : `${hop} hop${hop === 1 ? "" : "s"}`}
          mono={false}
        />
      ))}
    </div>
  );
}

function LegendRow({ color, label, count, mono = true }: { color: string; label: string; count?: number; mono?: boolean }) {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className={cn("min-w-0 flex-1 truncate text-muted-foreground", mono ? "font-mono text-[11px]" : "text-[11px]")}>
        {label}
      </span>
      {count !== undefined && <span className="shrink-0 text-[10px] text-muted-foreground">{count}</span>}
    </div>
  );
}

/** Discovery + color-by-folder: which top-level dir wears which color. */
function FolderLegend({ colors, other }: { colors: Map<string, string>; other: string }) {
  const entries = [...colors.entries()].filter(([, c]) => c !== other);
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
            style={{ backgroundColor: other }}
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
  const root = useBrainUiRoot();
  const discovery = useGraphStore((s) => s.discovery);
  const staleDays = useGraphStore((s) => s.maintenance.staleDays);
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<GraphNodePayload[] | null>(null);

  useEffect(() => { setNodes(null); setOpen(false); }, [root]);
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
        const res = await root.request(
          `${root.apiBase()}/graph/maintenance?${buildQuery({ staleDays })}`
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
  }, [open, needsFallbackProof, isDefaultRoot, nodes, staleDays, root]);

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
  const root = useBrainUiRoot();
  const setDiscoveryParams = useGraphStore((s) => s.setDiscoveryParams);
  const [candidates, setCandidates] = useState<
    { path: string; title: string }[] | null
  >(null);

  useEffect(() => {
    setCandidates(null);
    let cancelled = false;
    void (async () => {
      try {
        const res = await root.request(
          `${root.apiBase()}/brain/list?${buildQuery({ type: "index", limit: 6 })}`
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
  }, [root]);

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
