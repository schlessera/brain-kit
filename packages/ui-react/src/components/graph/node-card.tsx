import { Button, Chip, PathRef, Surface } from "@schlessera/brain-ui-kit";

/**
 * The selected node's card, rendered from props (S7). `NodePopover` is the
 * container: it reads the graph, file and UI stores and decides which
 * actions apply; this draws a kit `Surface` with the node's kind and topic
 * as chips, its path as a `PathRef`, its degrees as machine meta, and the
 * actions as kit `Button`s — "Open note" primary, the rest ghost.
 */
export interface NodeCardProps {
  kind: string;
  title: string;
  path: string;
  topic?: string | null;
  /** The topic cluster's swatch colour, from the canvas's own palette. */
  topicColor?: string;
  inDegree: number;
  outDegree: number;
  /** Hops from the centre; 0 or undefined draws nothing. */
  distance?: number;
  canOpen: boolean;
  canFocus: boolean;
  canExpand: boolean;
  onOpen: () => void;
  onFocus: () => void;
  onExpand: () => void;
  onClose: () => void;
}

export function NodeCard(p: NodeCardProps) {
  const hops = p.distance !== undefined && p.distance > 0 ? `${p.distance} hop${p.distance === 1 ? "" : "s"}` : null;
  return (
    <div className="pointer-events-auto absolute inset-x-2 bottom-2 z-10 shadow-2xl md:inset-x-auto md:bottom-4 md:left-4 md:w-80">
      <Surface emphasis="strong" pad={12}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Chip label={p.kind} variant="kv" tone="neutral" caps />
            {p.topic && (
              <span title="Topic cluster inferred from this note's links" className="flex min-w-0 items-center gap-1.5">
                {p.topicColor && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: p.topicColor }} />}
                <Chip label={`topic: ${p.topic}`} variant="kv" tone="purple" />
              </span>
            )}
          </div>
          <Button label="Close" icon="dismiss" tone="quiet" size="sm" block={false} onClick={p.onClose} />
        </div>
        <h3 className="mt-2 truncate text-sm font-medium text-foreground">{p.title}</h3>
        <div className="mt-1 flex min-w-0">
          <PathRef text={p.path} variant="inline" tone="teal" icon="file" />
        </div>
        <div className="mt-2 flex gap-4 font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">
          <span>{p.inDegree} in</span>
          <span>{p.outDegree} out</span>
          {hops && <span>{hops}</span>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {p.canOpen && <Button label="Open note" icon="file" tone="primary" size="sm" block={false} onClick={p.onOpen} />}
          {p.canFocus && <Button label="Focus here" icon="graph" tone="ghost" size="sm" block={false} onClick={p.onFocus} />}
          {p.canExpand && <Button label="Expand" icon="expand" tone="ghost" size="sm" block={false} onClick={p.onExpand} />}
        </div>
      </Surface>
    </div>
  );
}
