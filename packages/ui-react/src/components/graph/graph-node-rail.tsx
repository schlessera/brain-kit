import { useMemo } from "react";
import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import {
  ContactCard,
  Label,
  RelatedFiles,
  type ContactAction,
  type ContactFact,
  type ContactKind,
  type ContactTone,
} from "@schlessera/brain-ui-kit";

import { useGraphStore } from "../../stores/graph-store.js";
import { hopsLabel, useNodeActions } from "./use-node-actions.js";

/**
 * D6's 340px right rail, from `wide:` only: `Label "Selected node"` + the
 * node as a kit `ContactCard` ("a graph node and a chat entity are the same
 * object"), then `Label "Edges"` + the node's neighbours in the scene as a
 * `RelatedFiles` list. Below `wide:` the floating `NodePopover` draws the
 * node instead.
 *
 * The neighbours come from `subgraph.edges` — the scene's edges, not the
 * corpus's — so the count is "edges drawn", and a truncated scene may hold
 * fewer than the node's degree. The card's facts carry the true degrees.
 */
export function GraphNodeRail() {
  const subgraph = useGraphStore((s) => s.subgraph);
  const selectedId = useGraphStore((s) => s.selectedId);

  const node = useMemo(
    () =>
      selectedId === null || !subgraph
        ? null
        : (subgraph.nodes.find((n) => n.id === selectedId) ?? null),
    [selectedId, subgraph]
  );

  return (
    <aside
      aria-label="Selected node"
      className="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface px-4 py-4"
    >
      <Label text="Selected node" icon="capability" />
      {node ? (
        <SelectedNode node={node} />
      ) : (
        <p className="font-mono text-[10px] text-muted-foreground">
          click a node on the canvas
        </p>
      )}
    </aside>
  );
}

function SelectedNode({ node }: { node: GraphNodePayload }) {
  const subgraph = useGraphStore((s) => s.subgraph)!;
  const meta = useGraphStore((s) => s.meta);
  const select = useGraphStore((s) => s.select);
  const actions = useNodeActions(node);

  const isVirtual = node.virtual === true;
  const kindLabel = isVirtual ? "root" : node.type;
  const topic =
    node.community !== undefined
      ? (meta?.communities.find((c) => c.community === node.community)?.label ?? null)
      : null;

  const facts: ContactFact[] = [
    { k: "in-degree", v: String(node.inDegree) },
    { k: "out-degree", v: String(node.outDegree) },
  ];
  const hops = hopsLabel(node.distance);
  if (hops) facts.push({ k: "hops", v: hops });
  if (topic) facts.push({ k: "topic", v: topic, tone: "purple" });

  const cardActions: ContactAction[] = [];
  if (actions.canOpen)
    cardActions.push({ label: "Open note", icon: "file", tone: "primary", onClick: actions.open });
  if (actions.canFocus)
    cardActions.push({ label: "Focus here", icon: "graph", tone: "ghost", onClick: actions.focus });
  if (actions.canExpand)
    cardActions.push({ label: "Expand", icon: "expand", tone: "ghost", onClick: actions.expand });

  const neighbours = useMemo(() => {
    const byId = new Map(subgraph.nodes.map((n) => [n.id, n]));
    const out: { node: GraphNodePayload; direction: "out" | "in" }[] = [];
    const seen = new Set<number>();
    for (const edge of subgraph.edges) {
      const otherId =
        edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
      if (otherId === null || seen.has(otherId)) continue;
      const other = byId.get(otherId);
      if (!other) continue;
      seen.add(otherId);
      out.push({ node: other, direction: edge.source === node.id ? "out" : "in" });
    }
    return out;
  }, [subgraph, node.id]);

  const entity = entityShape(node.type);

  return (
    <>
      <ContactCard
        label={node.title || node.path}
        role={`${kindLabel} · ${node.path}`}
        kind={entity.kind}
        tone={entity.tone}
        facts={facts}
        actions={cardActions}
        keyWidth={72}
      />
      {neighbours.length > 0 && (
        <>
          <Label text="Edges" icon="files" tone="teal" meta={`${neighbours.length} drawn`} />
          <RelatedFiles
            label=""
            meta=""
            items={neighbours.map(({ node: other, direction }) => ({
              path: other.title || other.path,
              reason: direction === "out" ? `links to · ${other.path}` : `linked from · ${other.path}`,
              icon: other.virtual ? "graph" : "file",
              tone: direction === "out" ? "teal" : "blue",
              onClick: () => select(other.id),
            }))}
          />
        </>
      )}
    </>
  );
}

/**
 * The card's avatar follows the entity language (teal person, blue company,
 * purple project). A document type outside that vocabulary is drawn as a
 * neutral rounded square — the kit has no "note" kind, and a circle would
 * claim it is a person.
 */
function entityShape(type: string): { kind: ContactKind; tone: ContactTone } {
  const t = type.toLowerCase();
  if (t === "person" || t === "people" || t === "contact") return { kind: "person", tone: "teal" };
  if (t === "company" || t === "organization" || t === "organisation" || t === "org")
    return { kind: "company", tone: "blue" };
  if (t === "project") return { kind: "project", tone: "purple" };
  return { kind: "project", tone: "neutral" };
}
