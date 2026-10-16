import type { ContentRendererProps } from "@schlessera/brain-ui-sdk/client";
export default function Demo({ source, path, mode, theme }: ContentRendererProps) {
  if (source === "throw") throw new Error("Odysseus fixture renderer failed");
  return <figure aria-label="Odysseus renderer" data-renderer-mode={mode} data-renderer-theme={theme} data-renderer-path={path}><figcaption>{source}</figcaption></figure>;
}
