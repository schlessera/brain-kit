import { GraphView } from "@schlessera/brain-ui-kit";
import type { Block } from "@schlessera/brain-ui-sdk/client";
import { classifyRepoPath } from "../../../stores/file-store.js";
import { planGraph } from "../../../lib/graph-layout.js";
import { FileLink } from "../brain-markdown-links.js";

type GraphBlock = Extract<Block, { kind: "graph" }>;

function permittedPath(path: string | undefined): path is string {
  return Boolean(path && classifyRepoPath(path) === "file"
    && path.split("/").every(part => part !== "." && part !== ".." && part !== ""));
}

export function GraphBlockCard({ block, isStatic }: { block: GraphBlock; isStatic: boolean }) {
  const layout = planGraph(block.nodes, block.legend?.length ?? 0);
  return (
    <section aria-label={block.title || "Connections"} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <div aria-hidden="true">
        <GraphView {...layout} edges={block.edges} connectFocus={false} nodeMaxWidth="42%"
          label={block.title ?? ""} meta={block.meta ?? ""} legend={block.legend ?? []} />
      </div>
      <ol data-graph-node-list aria-label="Nodes">
        {block.nodes.map((node, i) => (
          <li key={i}>
            {!isStatic && permittedPath(node.path)
              ? <FileLink path={node.path} style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }}>{node.label}</FileLink>
              : node.label}
            {node.path ? <span style={{ display: "block", fontSize: ".85em" }}>{node.path}</span> : null}
          </li>
        ))}
      </ol>
      <ul data-graph-edge-list aria-label="Connections">
        {block.edges.map(([a, b], i) => <li key={i}>{block.nodes[a]!.label} ↔ {block.nodes[b]!.label}</li>)}
      </ul>
    </section>
  );
}
