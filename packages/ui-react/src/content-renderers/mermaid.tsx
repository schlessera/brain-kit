import { lazy } from "react";
import type { ContentRendererPack } from "@schlessera/brain-ui-sdk/client";
import { renderMermaidSvg } from "../lib/mermaid.js";
import { staticMermaidSvg } from "../lib/mermaid-svg.js";
import { mermaidThemeVariables } from "../lib/mermaid-theme.js";

const MermaidContent = lazy(() => import("./mermaid-content.js").then(module => ({ default: module.MermaidContent })));

/** First-party code bundled with the app; content configuration cannot load it. */
export const mermaidContentPack: ContentRendererPack = { renderers: [{
  languages: ["mermaid", "mmd"], extensions: [".mmd", ".mermaid"], needsBrowser: true,
  Component: MermaidContent,
  async toStatic(source, { theme }) {
    if (typeof document === "undefined") throw Error("Mermaid static rendering requires a browser.");
    const svg = await renderMermaidSvg(source, theme);
    if (!svg) throw Error("This diagram cannot be rendered yet.");
    const ground = String(mermaidThemeVariables(theme).background);
    const name = svg.match(/\bid="(brain-mermaid-\d+)"/)?.[1];
    if (!name) throw Error("Mermaid static rendering has no identity.");
    return `<div class="mermaid-figure ${name}-figure"><style data-content-renderer-tokens>.${name}-figure{--bk-mermaid-paper:${ground};${theme === "print" ? "background-color:var(--bk-mermaid-paper);" : ""}}</style>${staticMermaidSvg(svg, theme)}</div>`;
  },
}] };
