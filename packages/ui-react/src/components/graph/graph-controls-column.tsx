import { useGraphStore, type GraphMode } from "../../stores/graph-store.js";
import { ControlsBody } from "./graph-controls.js";
import { DisabledToggleRow, Field, Rows, Segmented } from "./graph-form.js";

export const MODES: { value: GraphMode; label: string }[] = [
  { value: "clusters", label: "Clusters" },
  { value: "discovery", label: "Discovery" },
  { value: "local", label: "Local" },
  { value: "maintenance", label: "Maintenance" },
];

/**
 * D6's 264px controls column, from `laptop:` up: the serif "Graph" title,
 * `Label "Mode"` + `FilterRow`, the per-mode form (`ControlsBody` — the
 * same one the phone sheet shows), and a mono footer with the counts the
 * store already has. The footer is silent until a scene has landed; it
 * never estimates.
 */
export function GraphControlsColumn() {
  const mode = useGraphStore((s) => s.mode);
  const setMode = useGraphStore((s) => s.setMode);

  return (
    <aside
      aria-label="Graph controls"
      className="flex w-[264px] shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="px-4 pb-3 pt-4">
        <h1 className="font-display text-lg text-foreground">Graph</h1>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <Field label="Mode">
          <Segmented
            options={MODES}
            value={mode}
            onChange={(v) => setMode(v as GraphMode)}
          />
        </Field>
        <ControlsBody />
        {/* D6's switches, drawn but disabled with their reasons (sixth pass
            §3b, the palette's rule). A scene node carries no `mtime` and no
            provenance record — `GraphNodePayload` has type, degrees,
            community, distance — so neither switch can fire here yet; the
            footer's gold line says the same thing. */}
        {mode !== "maintenance" && (
          <Rows>
            <DisabledToggleRow label="Mark stale" reason="needs mtime" tone="amber" />
            <DisabledToggleRow label="Untrusted only" reason="needs provenance" tone="purple" last />
          </Rows>
        )}
      </div>
      <ColumnFooter />
    </aside>
  );
}

function ColumnFooter() {
  const mode = useGraphStore((s) => s.mode);
  const subgraph = useGraphStore((s) => s.subgraph);
  const total = useGraphStore((s) => s.meta?.nodeCount);
  const local = useGraphStore((s) => s.local);

  if (!subgraph) return null;
  const drawn = subgraph.nodes.length.toLocaleString();
  const first =
    total !== undefined
      ? `${drawn} of ${total.toLocaleString()} nodes drawn`
      : `${drawn} nodes drawn`;
  const second =
    mode === "local"
      ? `${local.depth}-hop · ${DIRECTION_LABEL[local.direction]}`
      : `${subgraph.edges.length.toLocaleString()} edges${subgraph.truncated ? " · truncated" : ""}`;

  return (
    <div className="flex flex-col gap-0.5 border-t border-border px-4 py-3 font-mono text-[10px] text-muted-foreground">
      <span>{first}</span>
      <span>{second}</span>
      {/* True of every scene the API serves today: nodes carry no mtime and
          no provenance. Printed in gold, as D6 draws it, and only while it
          is true — the switches above are disabled for the same reasons. */}
      {mode !== "maintenance" && (
        <span className="text-[var(--bk-gold-ink)]">stale needs mtime · untrusted needs provenance</span>
      )}
    </div>
  );
}

const DIRECTION_LABEL = {
  in: "inbound only",
  out: "outbound only",
  both: "both directions",
} as const;
