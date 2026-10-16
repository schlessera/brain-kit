import type { ContentRendererProps } from "@schlessera/brain-ui-sdk/client";
import { MermaidBlock } from "../components/chat/mermaid-block.js";
import { isMermaidPath } from "../lib/mermaid.js";

export function MermaidContent({ source, theme, mode, path }: ContentRendererProps) {
  return <div data-content-renderer="mermaid" data-renderer-mode={mode} data-renderer-path={path}
    className={mode === "file" && path && isMermaidPath(path) ? "brain-prose max-w-none px-6 py-4" : undefined}>
    <MermaidBlock source={source} theme={theme} />
  </div>;
}
