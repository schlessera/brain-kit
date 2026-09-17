import { useBrainUiRoot } from "../../root-context.js";
import { useEffect, useRef, useState } from "react";
import { Code, ChartNetwork, Expand } from "lucide-react";
import { peekMermaidSvg, renderMermaidSvg } from "../../lib/mermaid.js";
import { ShareMenu } from "../share/share-menu.js";
import { CopyButton } from "./copy-button.js";
import { buildDiagramShareOptions } from "./mermaid-share.js";
import { MermaidViewer } from "./mermaid-viewer.js";

/**
 * A ```mermaid fence, rendered as a diagram.
 *
 * Streaming-safe by construction: while the fence is still arriving (or the
 * source is invalid) the raw source shows as an ordinary code block; each
 * debounced parse that succeeds swaps in the fresh SVG, and a parse that
 * fails keeps the last good diagram instead of flashing an error. Renders
 * are cached module-wide, so the per-token re-render of a streaming message
 * costs a cache lookup, not a mermaid parse.
 */
export function MermaidBlock({ source }: { source: string }) {
  const root = useBrainUiRoot();
  const [svg, setSvg] = useState<string | null>(() => peekMermaidSvg(source));
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const latest = useRef(0);
  const lastAttempt = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    const cached = peekMermaidSvg(source);
    if (cached) {
      setSvg(cached);
      return;
    }
    // Debounce with a throttle floor: a pure debounce would starve during a
    // continuous stream of WS deltas and only render once the stream pauses.
    // Attempting at least every 400ms lets the diagram grow mid-stream while
    // still coalescing per-token churn.
    const wait = Date.now() - lastAttempt.current > 400 ? 0 : 150;
    const t = setTimeout(() => {
      lastAttempt.current = Date.now();
      void renderMermaidSvg(source).then((result) => {
        if (latest.current !== id || !result) return;
        setSvg(result);
      });
    }, wait);
    return () => clearTimeout(t);
  }, [source]);

  const diagramReady = svg !== null;
  const showDiagram = diagramReady && !showSource;

  const iconBtn =
    "flex h-7 w-7 items-center justify-center rounded-md bg-surface-raised/80 text-muted-foreground transition-all hover:bg-surface-overlay hover:text-foreground";

  return (
    // No `overflow-hidden` here: the share menu drops out of the toolbar and a
    // clipping ancestor would cut off its lower entries on a short diagram.
    // Children carry their own padding, so nothing bleeds past the radius.
    <div className="group relative my-3 rounded-lg border border-border bg-surface">
      {showDiagram ? (
        <div
          className="cursor-zoom-in overflow-x-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          // The whole diagram is the affordance: a phone-sized flowchart is
          // unreadable in place, and the hover toolbar is pointer-only.
          onClick={() => setZoomed(true)}
          dangerouslySetInnerHTML={{ __html: svg ?? "" }}
        />
      ) : (
        <pre className="overflow-x-auto p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed">
          <code>{source}</code>
        </pre>
      )}
      <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-all focus-within:opacity-100 group-hover:opacity-100">
        {showDiagram && (
          <button type="button" title="Open diagram" onClick={() => setZoomed(true)} className={iconBtn}>
            <Expand className="h-3.5 w-3.5" />
          </button>
        )}
        {diagramReady && (
          <ShareMenu
            options={buildDiagramShareOptions(root, source)}
            title="Share diagram"
            renderTrigger={({ onClick, busy, icon }) => (
              <button type="button" title="Share diagram" onClick={onClick} disabled={busy} className={iconBtn}>
                {icon}
              </button>
            )}
          />
        )}
        {diagramReady && (
          <button
            type="button"
            title={showDiagram ? "Show source" : "Show diagram"}
            onClick={() => setShowSource((s) => !s)}
            className={iconBtn}
          >
            {showDiagram ? <Code className="h-3.5 w-3.5" /> : <ChartNetwork className="h-3.5 w-3.5" />}
          </button>
        )}
        <CopyButton getText={() => source} className={iconBtn} />
      </div>
      {zoomed && svg && (
        <MermaidViewer svg={svg} source={source} onClose={() => setZoomed(false)} />
      )}
    </div>
  );
}
