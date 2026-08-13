/**
 * The rendering seam: this file is the ONLY module in the package that imports
 * sigma or graphology. Everything it receives is renderer-agnostic (plain
 * nodes/edges/positions + callbacks), so swapping the renderer later touches
 * this file alone.
 *
 * Loaded via React.lazy from graph-page, so sigma lands in its own chunk and
 * the main bundle stays untouched.
 */
import { useEffect, useRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type {
  GraphEdgePayload,
  GraphNodePayload,
  GraphSubgraphResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  labelSet,
  nodeSize,
  radialLayout,
  type SizeBy,
} from "./lib/graph-helpers.js";
import { useGraphTheme } from "./use-graph-theme.js";

export interface GraphCanvasProps {
  data: GraphSubgraphResponse;
  layout: "fixed" | "radial" | "force";
  selectedId: number | null;
  hoveredId: number | null;
  matchIds: ReadonlySet<number>;
  sizeBy?: SizeBy;
  /** Radial mode: draw this many distance rings (with hop labels) under the graph. */
  rings?: number;
  /** Mode-specific node color (community, distance, …). */
  nodeColor: (node: GraphNodePayload) => string;
  /** Optional per-edge color override (e.g. backlinks into the local center). */
  edgeColor?: (edge: GraphEdgePayload) => string | undefined;
  onSelect: (id: number | null) => void;
  onHover: (id: number | null) => void;
}

/** Force-layout budget: enough to settle an ego graph, cheap enough for a phone. */
function forceIterations(nodeCount: number): number {
  if (nodeCount <= 150) return 300;
  if (nodeCount <= 500) return 150;
  return 60;
}

export default function GraphCanvas({
  data,
  layout,
  selectedId,
  hoveredId,
  matchIds,
  sizeBy = "degree",
  rings = 0,
  nodeColor,
  edgeColor,
  onSelect,
  onHover,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ringCanvasRef = useRef<HTMLCanvasElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const theme = useGraphTheme();
  const ringCount = layout === "radial" ? rings : 0;

  // State the reducers read without re-instantiating sigma.
  const interactionRef = useRef({
    selectedId,
    hoveredId,
    matchIds,
    forced: new Set<number>(),
    neighborsOfActive: new Set<string>(),
  });

  // Latest callbacks for the event handlers registered once at mount.
  const callbacksRef = useRef({ onSelect, onHover });
  callbacksRef.current = { onSelect, onHover };

  // Mount sigma once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const graph = new Graph({ type: "directed", multi: false });
    const renderer = new Sigma(graph, container, {
      allowInvalidContainer: true,
      renderLabels: true,
      labelFont: "Plus Jakarta Sans, system-ui, sans-serif",
      labelSize: 11,
      labelColor: { color: theme.label },
      labelRenderedSizeThreshold: 7,
      defaultEdgeType: "arrow",
      minCameraRatio: 0.05,
      maxCameraRatio: 6,
      stagePadding: 40,
      nodeReducer: (node, attrs) => {
        const id = Number(node);
        const s = interactionRef.current;
        const active = s.hoveredId ?? s.selectedId;
        const out = { ...attrs } as typeof attrs & {
          forceLabel?: boolean;
          zIndex?: number;
        };
        out.forceLabel = s.forced.has(id);
        if (s.matchIds.size > 0 && s.matchIds.has(id)) {
          out.color = theme.nodeSelected;
          out.zIndex = 2;
        }
        if (id === s.selectedId || id === s.hoveredId) {
          out.color = theme.nodeSelected;
          out.highlighted = true;
          out.zIndex = 3;
        } else if (active !== null && !s.neighborsOfActive.has(node)) {
          // Fade everything not adjacent to the active node.
          out.color = theme.edge;
          out.label = undefined;
          out.forceLabel = false;
        }
        return out;
      },
      edgeReducer: (edge, attrs) => {
        const s = interactionRef.current;
        const active = s.hoveredId ?? s.selectedId;
        const out = { ...attrs } as typeof attrs & { hidden?: boolean };
        if (active !== null) {
          const g = sigmaRef.current?.getGraph();
          if (g) {
            const activeKey = String(active);
            const touchesActive =
              g.source(edge) === activeKey || g.target(edge) === activeKey;
            if (touchesActive) {
              out.color = theme.edgeHighlight;
              out.size = Math.max((attrs.size as number | undefined) ?? 1, 1.5);
            } else {
              out.hidden = true;
            }
          }
        }
        return out;
      },
    });

    renderer.on("clickNode", ({ node }) => callbacksRef.current.onSelect(Number(node)));
    renderer.on("clickStage", () => callbacksRef.current.onSelect(null));
    renderer.on("enterNode", ({ node }) => callbacksRef.current.onHover(Number(node)));
    renderer.on("leaveNode", () => callbacksRef.current.onHover(null));

    sigmaRef.current = renderer;
    return () => {
      renderer.kill();
      sigmaRef.current = null;
    };
    // Theme is read once per mount (dark-only app).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)build the graph when the scene changes.
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    const graph = renderer.getGraph();

    // Keep positions of survivors so expansion merges don't reshuffle the scene.
    const previous = new Map<string, { x: number; y: number }>();
    graph.forEachNode((node, attrs) =>
      previous.set(node, { x: attrs.x as number, y: attrs.y as number })
    );
    graph.clear();

    const radial = layout === "radial" ? radialLayout(data.nodes) : null;

    data.nodes.forEach((node, i) => {
      let x: number;
      let y: number;
      if (layout === "fixed" && node.x !== undefined && node.y !== undefined) {
        x = node.x;
        y = node.y;
      } else if (radial) {
        const p = radial.get(node.id)!;
        x = p.x;
        y = p.y;
      } else {
        const kept = previous.get(String(node.id));
        if (kept) {
          ({ x, y } = kept);
        } else {
          // Deterministic circle seed; FA2 takes it from here.
          const angle = (2 * Math.PI * i) / data.nodes.length;
          x = Math.cos(angle);
          y = Math.sin(angle);
        }
      }
      graph.addNode(String(node.id), {
        x,
        y,
        size: nodeSize(node, sizeBy),
        color: nodeColor(node),
        label: node.title || node.path,
      });
    });

    for (const edge of data.edges) {
      const source = String(edge.source);
      const target = String(edge.target);
      if (!graph.hasNode(source) || !graph.hasNode(target)) continue;
      if (graph.hasEdge(source, target)) continue;
      graph.addEdge(source, target, {
        color: edgeColor?.(edge) ?? theme.edge,
        size: 1,
      });
    }

    if (layout === "force" && graph.order > 2) {
      const settings = forceAtlas2.inferSettings(graph);
      forceAtlas2.assign(graph, {
        iterations: forceIterations(graph.order),
        settings: { ...settings, barnesHutOptimize: graph.order > 300 },
      });
    }

    renderer.getCamera().animatedReset({ duration: 250 });
    renderer.refresh();
    // nodeColor/edgeColor identity changes accompany data/mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layout, sizeBy]);

  // Interaction + label policy updates (no graph rebuild).
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    const state = interactionRef.current;
    state.selectedId = selectedId;
    state.hoveredId = hoveredId;
    state.matchIds = matchIds;

    const active = hoveredId ?? selectedId;
    state.neighborsOfActive = new Set<string>();
    if (active !== null) {
      const graph = renderer.getGraph();
      const key = String(active);
      if (graph.hasNode(key)) {
        state.neighborsOfActive.add(key);
        graph.forEachNeighbor(key, (n) => state.neighborsOfActive.add(n));
      }
    }

    const recomputeLabels = () => {
      state.forced = labelSet({
        nodes: data.nodes,
        selectedId,
        hoveredId,
        matchIds,
        cameraRatio: renderer.getCamera().ratio,
      });
      renderer.refresh({ skipIndexation: true });
    };
    recomputeLabels();

    // More labels as the user zooms in; throttled to one recompute per frame batch.
    let pending = 0;
    const onCameraUpdate = () => {
      if (pending) return;
      pending = window.setTimeout(() => {
        pending = 0;
        recomputeLabels();
      }, 150);
    };
    renderer.getCamera().on("updated", onCameraUpdate);
    return () => {
      renderer.getCamera().off("updated", onCameraUpdate);
      if (pending) window.clearTimeout(pending);
    };
  }, [data, selectedId, hoveredId, matchIds]);

  // Distance rings under the radial layout — an underlay canvas redrawn in
  // sync with sigma's camera (the sigma canvases are transparent, so it shows
  // through).
  useEffect(() => {
    const renderer = sigmaRef.current;
    const canvas = ringCanvasRef.current;
    if (!renderer || !canvas || ringCount === 0) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth, clientHeight } = canvas;
      if (canvas.width !== clientWidth * dpr) canvas.width = clientWidth * dpr;
      if (canvas.height !== clientHeight * dpr) canvas.height = clientHeight * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, clientWidth, clientHeight);

      const center = renderer.graphToViewport({ x: 0, y: 0 });
      const edge = renderer.graphToViewport({ x: 1, y: 0 });
      const unit = Math.hypot(edge.x - center.x, edge.y - center.y);
      if (!Number.isFinite(unit) || unit <= 0) return;

      ctx.strokeStyle = theme.edge;
      ctx.fillStyle = theme.labelMuted;
      ctx.font = "10px Plus Jakarta Sans, system-ui, sans-serif";
      ctx.textAlign = "center";
      for (let d = 1; d <= ringCount; d++) {
        const radius = unit * d;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
        ctx.stroke();
        // Hop label at the top of the ring, skipped once rings get dense.
        if (unit > 28) {
          ctx.globalAlpha = 0.9;
          ctx.fillText(String(d), center.x, center.y - radius - 4);
        }
      }
      ctx.globalAlpha = 1;
    };

    draw();
    renderer.on("afterRender", draw);
    return () => {
      renderer.off("afterRender", draw);
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [ringCount, theme, data]);

  return (
    <div aria-hidden="true" className="absolute inset-0">
      {ringCount > 0 && (
        <canvas
          ref={ringCanvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      )}
      <div ref={containerRef} className="absolute inset-0 touch-none" />
    </div>
  );
}
