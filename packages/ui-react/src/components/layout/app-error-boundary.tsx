import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { color, font } from "@schlessera/brain-ui-kit";
import { isStaleChunk, markReload } from "../../lib/lazy-chunk.js";
import { redactProviderMessage } from "../../lib/turn-failure.js";
import { CLIENT_RELEASE } from "../../lib/stats/software.js";
import { ErrorBoundary } from "./error-boundary.js";

export interface AppErrorBoundaryProps {
  children: ReactNode;
  /** Test hook: observe the reload without navigating. */
  reload?: () => void;
}

/**
 * The outermost boundary a shell wraps around everything, providers included
 * (#1377). Its screen reads no context and uses no kit component, because the
 * provider or the kit may be what failed. Without the kit stylesheet it falls
 * back to the browser's own colours and controls, so it stays legible.
 */
export function AppErrorBoundary({ children, reload }: AppErrorBoundaryProps) {
  return (
    <ErrorBoundary
      onError={(error) => console.error("[boundary:root] The app failed.", error)}
      fallback={({ error }) => <RootFallback error={error} reload={reload} />}
    >
      {children}
    </ErrorBoundary>
  );
}

// Kit tokens, each with a CSS system colour behind it for when the kit
// stylesheet is missing.
const S: Record<string, CSSProperties> = {
  screen: { minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, boxSizing: "border-box", background: `var(--bk-color-canvas, Canvas)`, color: `var(--bk-color-ink, CanvasText)` },
  column: { maxWidth: 320, width: "100%", display: "flex", flexDirection: "column", gap: 12, textAlign: "center" },
  title: { font: `400 21px/1.2 ${font.display}`, margin: 0, outline: "none" },
  body: { font: `400 13.5px/1.6 ${font.body}`, color: color.inkDim, margin: 0 },
  button: { minHeight: 44, width: "100%", borderRadius: 12, border: "1px solid var(--bk-amber-fill, ButtonBorder)", background: "var(--bk-amber-fill, ButtonFace)", color: `var(--bk-on-fill, ButtonText)`, font: `600 13.5px/1.25 ${font.body}`, cursor: "pointer" },
  details: { font: `400 11px/1.5 ${font.mono}`, color: color.inkMute, textAlign: "start", overflowWrap: "anywhere" },
  summary: { minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer" },
  pre: { margin: 0, whiteSpace: "pre-wrap", userSelect: "text" },
};

function RootFallback({ error, reload }: { error: unknown; reload?: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const stale = isStaleChunk(error);
  const name = error instanceof Error && error.name ? error.name : "Error";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const details = [
    `error: ${name}`,
    ...(message ? [`message: ${redactProviderMessage(message).slice(0, 500)}`] : []),
    `client: ${CLIENT_RELEASE}`,
    `time: ${new Date().toISOString()}`,
  ].join("\n");
  return (
    <div style={S.screen} data-app-fallback="">
      <div style={S.column}>
        <h1 ref={heading} tabIndex={-1} style={S.title}>{stale ? "A new version is ready" : "Brain stopped working"}</h1>
        <p style={S.body}>{stale ? "Brain was updated since this page opened. Reload to continue." : "An error stopped the app from drawing. Reloading starts it fresh."}</p>
        <button type="button" aria-label="Reload Brain" style={S.button} onClick={() => {
          try { markReload(sessionStorage); } catch { /* storage may be unavailable */ }
          if (reload) reload(); else window.location.reload();
        }}>Reload</button>
        <details style={S.details}>
          <summary style={S.summary}>Details for a bug report</summary>
          <pre style={S.pre}>{details}</pre>
        </details>
      </div>
    </div>
  );
}
