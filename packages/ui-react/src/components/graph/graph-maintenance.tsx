import type { CSSProperties } from "react";
import { Suspense, useEffect, useMemo, useRef } from "react";
import type {
  GraphNodePayload,
  GraphSubgraphResponse,
} from "@schlessera/brain-ui-sdk/protocol";

import { useGraphStore } from "../../stores/graph-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useFileStore } from "../../stores/file-store.js";
import { GraphControls } from "./graph-controls.js";
import { NodePopover } from "./node-popover.js";
import { GraphEmptyState } from "./graph-empty-state.js";
import { GraphCanvas } from "./graph-canvas-lazy.js";
import { CenteredSpinner } from "./graph-spinner.js";
import { matchScene } from "../../lib/graph-helpers.js";
import { useGraphTheme } from "./use-graph-theme.js";
import { cn } from "../../lib/utils.js";

// --- Maintenance -------------------------------------------------------------

type FindingKind = "orphan" | "unreachable" | "stale";

interface FindingNode extends GraphNodePayload {
  finding: FindingKind;
}

/**
 * Maintenance: findings list ⇄ canvas, linked both ways. The canvas is a
 * type-grouped radial scene (one ring per finding kind — these nodes have no
 * edges between them by definition); broken links are list-only, since their
 * defining feature is a target that does not exist.
 */
export function MaintenanceBody() {
  const findings = useGraphStore((s) => s.findings);
  const dataState = useGraphStore((s) => s.dataState);
  const error = useGraphStore((s) => s.error);
  const filters = useGraphStore((s) => s.maintenanceFilters);
  const selectedId = useGraphStore((s) => s.selectedId);
  const select = useGraphStore((s) => s.select);
  const hoveredId = useGraphStore((s) => s.hoveredId);
  const hover = useGraphStore((s) => s.hover);
  const sceneQuery = useGraphStore((s) => s.sceneQuery);
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const listRef = useRef<HTMLDivElement>(null);
  // The four lenses: the kit's `--bk-canvas-lens-*`, resolved for the scheme
  // in force, so the list's headings and the canvas agree in both themes.
  const lens = useGraphTheme().palette.lens;

  // One node per document, first matching section wins (a stale orphan is an
  // orphan); ring index encodes the finding kind.
  const scene = useMemo(() => {
    if (!findings) return null;
    const seen = new Set<number>();
    const nodes: FindingNode[] = [];
    const push = (list: GraphNodePayload[], finding: FindingKind, ring: number) => {
      for (const node of list) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        nodes.push({ ...node, finding, distance: ring });
      }
    };
    if (filters.orphans) push(findings.orphans, "orphan", 1);
    if (filters.unreachable) push(findings.unreachable, "unreachable", 2);
    if (filters.stale) push(findings.stale, "stale", 3);
    const subgraph: GraphSubgraphResponse = { nodes, edges: [], truncated: false };
    return { subgraph, nodes };
  }, [findings, filters]);

  // Canvas → list: keep the selected row in view.
  useEffect(() => {
    if (selectedId === null) return;
    listRef.current
      ?.querySelector(`[data-node-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (dataState === "error") {
    return (
      <GraphEmptyState icon="warn" title="Could not load findings">
        {error?.message ?? "Request failed"}
      </GraphEmptyState>
    );
  }
  if (dataState !== "done" || !findings || !scene) return <CenteredSpinner />;

  const matchIds = matchScene(scene.nodes, sceneQuery);
  const selectedNode =
    selectedId === null
      ? null
      : (scene.nodes.find((n) => n.id === selectedId) ?? null);

  function openNote(path: string) {
    setFilePanelOpen(true);
    void openFile(path);
  }

  const totalShown =
    scene.nodes.length + (filters.broken ? findings.brokenLinks.length : 0);

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Canvas pane */}
      <div className="relative h-56 shrink-0 border-b border-border md:h-auto md:flex-1 md:border-b-0 md:border-r">
        {scene.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {totalShown === 0
              ? "Nothing to show — this brain is clean."
              : "Only broken links match — they live in the list."}
          </div>
        ) : (
          <Suspense fallback={<CenteredSpinner />}>
            <GraphCanvas
              data={scene.subgraph}
              layout="radial"
              selectedId={selectedId}
              hoveredId={hoveredId}
              matchIds={matchIds}
              nodeColor={(node) =>
                lens[(node as FindingNode).finding ?? "stale"]
              }
              onSelect={select}
              onHover={hover}
            />
          </Suspense>
        )}
        <GraphControls />
        {selectedNode && <NodePopover node={selectedNode} />}
      </div>

      {/* Findings list pane */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-4 py-4 md:w-96 md:flex-none md:px-5"
      >
        <div className="flex flex-col gap-5 pb-16">
          {filters.orphans && (
            <FindingSection
              title={`Orphans (${findings.orphans.length})`}
              hint="No links in or out."
              color={lens.orphan}
              nodes={findings.orphans}
              selectedId={selectedId}
              onSelect={select}
              onOpen={openNote}
            />
          )}
          {filters.unreachable && (
            <FindingSection
              title={`Unreachable from root (${findings.unreachable.length})`}
              hint="No link path from the graph root reaches these."
              color={lens.unreachable}
              nodes={findings.unreachable}
              selectedId={selectedId}
              onSelect={select}
              onOpen={openNote}
            />
          )}
          {filters.broken && (
            <section>
              <SectionHeading
                title={`Broken links (${findings.brokenLinks.length})`}
                hint="Wiki links whose target resolves to nothing."
                color={lens.broken}
              />
              <FindingRows
                empty={findings.brokenLinks.length === 0}
                rows={findings.brokenLinks.map((b, i) => ({
                  key: `b${i}`,
                  title: `[[${b.target}]]`,
                  sub: `in ${b.sourcePath}`,
                  onClick: () => openNote(b.sourcePath),
                }))}
              />
            </section>
          )}
          {filters.stale && (
            <FindingSection
              title={`Stale notes (${findings.stale.length})`}
              hint={`Untouched for over ${findings.staleDays} days.`}
              color={lens.stale}
              nodes={findings.stale}
              subOf={(n) => `${(n as GraphNodePayload & { updated: string }).updated} · ${n.path}`}
              selectedId={selectedId}
              onSelect={select}
              onOpen={openNote}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeading({
  title,
  hint,
  color,
}: {
  title: string;
  hint: string;
  color: string;
}) {
  return (
    <>
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: color }}
        />
        {title}
      </h2>
      <p className="mb-2 text-[11px] text-muted-foreground">{hint}</p>
    </>
  );
}

function FindingSection({
  title,
  hint,
  color,
  nodes,
  subOf,
  selectedId,
  onSelect,
  onOpen,
}: {
  title: string;
  hint: string;
  color: string;
  nodes: GraphNodePayload[];
  subOf?: (node: GraphNodePayload) => string;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <section>
      <SectionHeading title={title} hint={hint} color={color} />
      <FindingRows
        empty={nodes.length === 0}
        rows={nodes.map((node) => ({
          key: String(node.id),
          nodeId: node.id,
          title: node.title || node.path,
          sub: subOf ? subOf(node) : node.path,
          active: node.id === selectedId,
          onClick: () => onSelect(node.id),
          onDoubleClick: () => onOpen(node.path),
        }))}
      />
    </section>
  );
}

function FindingRows({
  rows,
  empty,
}: {
  empty: boolean;
  rows: {
    key: string;
    nodeId?: number;
    title: string;
    sub: string;
    active?: boolean;
    onClick: () => void;
    onDoubleClick?: () => void;
  }[];
}) {
  if (empty) {
    return (
      <p className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs text-muted-foreground">
        Nothing found — clean.
      </p>
    );
  }
  return (
    <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border bg-surface">
      {rows.map((row) => (
        <button style={{ "--hv-bg": "var(--bk-color-raised)" } as CSSProperties} /* raw-button: row — Composite maintenance row supports double-click. */
          key={row.key}
          data-node-id={row.nodeId}
          onClick={row.onClick}
          onDoubleClick={row.onDoubleClick}
          className={cn(
            "bk-row flex min-h-11 w-full flex-col justify-center px-3 py-2 text-left transition-colors",
            row.active ? "bg-surface-raised" : ""
          )}
        >
          <span className="truncate text-xs text-foreground">{row.title}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground/60">
            {row.sub}
          </span>
        </button>
      ))}
    </div>
  );
}
