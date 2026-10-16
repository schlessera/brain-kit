import { useBrainUiRoot } from "../../root-context.js";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@schlessera/brain-ui-kit";
import { Code, ChartNetwork, Expand } from "lucide-react";
import { peekMermaidSvg, renderMermaidSvg } from "../../lib/mermaid.js";
import type { MermaidTheme } from "../../lib/mermaid-theme.js";
import { useColorScheme } from "../../hooks/use-color-scheme.js";
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
 *
 * The diagram is drawn for the scheme the page is in — mermaid's variables
 * are literal colours, so a theme switch is a re-render (cached per scheme),
 * not a stylesheet change.
 */
export function MermaidBlock({ source, theme }: { source: string; theme?: MermaidTheme }) {
  const root = useBrainUiRoot();
  const screenScheme = useColorScheme();
  const scheme = theme ?? screenScheme;
  const [svg, setSvg] = useState<string | null>(() => peekMermaidSvg(source, scheme));
  const [printSvg, setPrintSvg] = useState<string | null>(() => peekMermaidSvg(source, "print"));
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const latest = useRef(0);
  const lastAttempt = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    const cached = peekMermaidSvg(source, scheme);
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
      void renderMermaidSvg(source, scheme).then((result) => {
        if (latest.current !== id || !result) return;
        setSvg(result);
      });
    }, wait);
    return () => clearTimeout(t);
  }, [source, scheme]);

  // Browser printing cannot wait for a render in beforeprint. Prepare the paper
  // version alongside the displayed diagram, retaining the last good streaming
  // result just as the screen view does.
  useEffect(() => {
    if (scheme === "print") return;
    let active = true;
    const timer = setTimeout(() => {
      void renderMermaidSvg(source, "print").then(result => {
        if (active && result) setPrintSvg(result);
      });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [source, scheme]);

  const diagramReady = svg !== null;
  const showDiagram = diagramReady && !showSource;

  return (
    // No `overflow-hidden` here: the share menu drops out of the toolbar and a
    // clipping ancestor would cut off its lower entries on a short diagram.
    // Children carry their own padding, so nothing bleeds past the radius.
    <div className="group relative my-3 rounded-lg border border-border bg-surface">
      {showDiagram ? (
        <div
          className={`cursor-zoom-in overflow-x-auto p-4 ${scheme !== "print" && printSvg ? "print:hidden" : ""} [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full`}
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
      {showDiagram && scheme !== "print" && printSvg && (
        <div data-mermaid-print="" className="hidden p-4 print:block [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: printSvg }} />
      )}
      <div className="print:hidden absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-all focus-within:opacity-100 group-hover:opacity-100">
        {showDiagram && (
          <IconButton size="sm" tone="overlay" name="Open diagram" glyph={<Expand />} onClick={() => setZoomed(true)} />
        )}
        {diagramReady && (
          <ShareMenu
            options={buildDiagramShareOptions(root, source)}
            title="Share diagram"
            renderTrigger={({ onClick, busy, icon }) => (
              <IconButton size="sm" tone="overlay" name="Share diagram" glyph={icon} haspopup="menu" onClick={onClick} disabled={busy} />
            )}
          />
        )}
        {diagramReady && (
          <IconButton
            size="sm"
            tone="overlay"
            name={showDiagram ? "Show source" : "Show diagram"}
            onClick={() => setShowSource((s) => !s)}
            glyph={showDiagram ? <Code /> : <ChartNetwork />}
          />
        )}
        <CopyButton getText={() => source} size="sm" tone="overlay" />
      </div>
      {zoomed && svg && (
        <MermaidViewer svg={svg} source={source} onClose={() => setZoomed(false)} />
      )}
    </div>
  );
}
