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
import type {
  NodeHoverDrawingFunction,
  NodeLabelDrawingFunction,
} from "sigma/rendering";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type {
  GraphEdgePayload,
  GraphNodePayload,
  GraphSubgraphResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  labelSet,
  mixColors,
  nodeSize,
  radialLayout,
  type SizeBy,
} from "./lib/graph-helpers.js";
import { useGraphTheme, type GraphTheme } from "./use-graph-theme.js";

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

/**
 * Node label drawer: sigma's default fillText plus a thin round-joined
 * stroke in `outline` underneath, so labels stay legible where they cross
 * nodes, edges, or each other. Geometry matches sigma 3.0.x's
 * drawDiscNodeLabel (x + size + 3, vertically centered on the node).
 */
function makeDrawNodeLabel(
  theme: GraphTheme,
  outline?: string
): NodeLabelDrawingFunction {
  return (context, data, settings) => {
    if (!data.label) return;
    const size = settings.labelSize;
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    const x = data.x + data.size + 3;
    const y = data.y + size / 3;
    context.strokeStyle = outline ?? theme.background;
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.strokeText(data.label, x, y);
    context.fillStyle = settings.labelColor.color ?? theme.label;
    context.fillText(data.label, x, y);
  };
}

/**
 * Hover/selected label drawer. Sigma's default draws the plate in hardcoded
 * #FFF — invisible under our near-white label text on a dark theme. Same
 * plate geometry (rounded box grown out of the node circle), but filled with
 * the overlay surface token, edged with the border token, and the label drawn
 * light with its outline in the plate color so it reads as solid text.
 */
function makeDrawNodeHover(theme: GraphTheme): NodeHoverDrawingFunction {
  const drawLabel = makeDrawNodeLabel(theme, theme.surfaceOverlay);
  return (context, data, settings) => {
    const size = settings.labelSize;
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    context.fillStyle = theme.surfaceOverlay;
    context.strokeStyle = theme.edge;
    context.lineWidth = 1;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 8;
    context.shadowColor = "#000";
    const PADDING = 2;
    if (typeof data.label === "string") {
      const textWidth = context.measureText(data.label).width;
      const boxWidth = Math.round(textWidth + 5);
      const boxHeight = Math.round(size + 2 * PADDING);
      const radius = Math.max(data.size, size / 2) + PADDING;
      const angleRadian = Math.asin(boxHeight / 2 / radius);
      const xDelta = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2));
      context.beginPath();
      context.moveTo(data.x + xDelta, data.y + boxHeight / 2);
      context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
      context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
      context.lineTo(data.x + xDelta, data.y - boxHeight / 2);
      context.arc(data.x, data.y, radius, angleRadian, -angleRadian);
      context.closePath();
      context.fill();
      context.shadowBlur = 0;
      context.stroke();
    } else {
      context.beginPath();
      context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2);
      context.closePath();
      context.fill();
      context.shadowBlur = 0;
    }
    drawLabel(context, data, settings);
  };
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
  // The reducers are registered once at mount and read the theme through this
  // ref, so a theme switch recolours the fade and the selection without
  // re-instantiating sigma.
  const themeRef = useRef(theme);
  themeRef.current = theme;
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
      defaultDrawNodeLabel: makeDrawNodeLabel(theme),
      defaultDrawNodeHover: makeDrawNodeHover(theme),
      defaultEdgeType: "arrow",
      minCameraRatio: 0.05,
      maxCameraRatio: 6,
      stagePadding: 40,
      nodeReducer: (node, attrs) => {
        const id = Number(node);
        const s = interactionRef.current;
        const theme = themeRef.current;
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
        } else if (active === null && s.matchIds.size > 0 && !s.matchIds.has(id)) {
          // Search highlight: non-matches recede at half the hover fade, so
          // the amber matches pop without the rest of the scene vanishing.
          out.color = mixColors((attrs.color as string) ?? theme.node, theme.edge, 0.5);
        }
        return out;
      },
      edgeReducer: (edge, attrs) => {
        const s = interactionRef.current;
        const theme = themeRef.current;
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

    // Camera gestures (mouse-drag pan, touch pan/pinch/rotate) sweep nodes
    // under a pointer that isn't "pointing" at them, and sigma re-derives
    // hover on every move — so without a gate, dragging flickers random nodes
    // in and out of the hover fade. Clicks/taps are already drag-suppressed by
    // sigma itself (draggedEventsTolerance / tapMoveTolerance); hover is not.
    // Gate: button held or a touch in progress means the pointer is steering
    // the camera, and mouse isMoving lingers for sigma's dragTimeout after
    // release, absorbing the tail of the gesture.
    const mouseCaptor = renderer.getMouseCaptor();
    const touchCaptor = renderer.getTouchCaptor();
    const isCameraGesture = () =>
      mouseCaptor.isMouseDown ||
      mouseCaptor.isMoving ||
      touchCaptor.isMoving ||
      touchCaptor.touchMode > 0;

    renderer.on("clickNode", ({ node }) => callbacksRef.current.onSelect(Number(node)));
    renderer.on("clickStage", () => callbacksRef.current.onSelect(null));
    renderer.on("enterNode", ({ node }) => {
      if (isCameraGesture()) return;
      callbacksRef.current.onHover(Number(node));
    });
    renderer.on("leaveNode", () => callbacksRef.current.onHover(null));

    // A gesture that starts while a node is already hovered must drop that
    // hover too, or the fade chases a stale node across the whole drag.
    const clearHoverDuringGesture = () => {
      if (isCameraGesture()) callbacksRef.current.onHover(null);
    };
    mouseCaptor.on("mousemovebody", clearHoverDuringGesture);
    touchCaptor.on("touchmovebody", clearHoverDuringGesture);

    sigmaRef.current = renderer;
    return () => {
      renderer.kill();
      sigmaRef.current = null;
    };
    // The theme the settings above close over is the mount-time one; the
    // effect below swaps them when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A theme switch re-applies the colours sigma was configured with — the
  // label ink and the two label drawers — in place. Node and edge colours
  // follow through the restyle effect, whose `nodeColor` and `theme` change
  // with it; the reducers read `themeRef`.
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    renderer.setSettings({
      labelColor: { color: theme.label },
      defaultDrawNodeLabel: makeDrawNodeLabel(theme),
      defaultDrawNodeHover: makeDrawNodeHover(theme),
    });
    renderer.refresh({ skipIndexation: true });
  }, [theme]);

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
        // Size and color are (re)applied by the restyle effect below; seeding
        // them here just avoids a one-frame flash of defaults.
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
    // Styling props (nodeColor/edgeColor/sizeBy) are deliberately NOT deps:
    // the restyle effect below reapplies them in place, so a display-only
    // change never re-runs layout or resets the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layout]);

  // Restyle in place when a display-only prop changes (color-by, size-by).
  // Runs after every rebuild too, which is idempotent and keeps one source of
  // truth for what the current colorFn/sizeBy say a node should look like.
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    const graph = renderer.getGraph();
    for (const node of data.nodes) {
      const key = String(node.id);
      if (!graph.hasNode(key)) continue;
      graph.setNodeAttribute(key, "color", nodeColor(node));
      graph.setNodeAttribute(key, "size", nodeSize(node, sizeBy));
    }
    for (const edge of data.edges) {
      const source = String(edge.source);
      const target = String(edge.target);
      if (!graph.hasEdge(source, target)) continue;
      graph.setEdgeAttribute(source, target, "color", edgeColor?.(edge) ?? theme.edge);
    }
    renderer.refresh({ skipIndexation: true });
  }, [data, nodeColor, edgeColor, sizeBy, theme]);

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
