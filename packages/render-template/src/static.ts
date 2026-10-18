import { Marked } from "marked";
import { buildDocument, buildHtmlDocument, type BuildHtmlDocumentOptions } from "./template.js";
import { lintDocument, type DocumentWarning } from "./lint.js";

/** Internal structural view of the existing SDK static renderer contract. */
interface StaticEntry {
  needsBrowser: boolean;
  toStatic(source: string, options: { theme: "print"; path?: string }): Promise<string>;
}

/** Shared CLI/API preparation; callers own trusted renderer resolution and file access. */
export async function prepareStaticDocument(opts: BuildHtmlDocumentOptions, options: {
  rendererFor?: (language: string) => StaticEntry | null | Promise<StaticEntry | null>;
  path?: string;
  localSvg?: (source: string) => Promise<string | null>;
} = {}): Promise<{ html: string; warnings: DocumentWarning[] }> {
  const warnings: DocumentWarning[] = [];
  let content = opts.content;
  if (opts.contentType === "markdown") {
    let fence = 0;
    const parser = new Marked({ gfm: true, breaks: false, async: true,
      ...(opts.linkPolicy ? { renderer: { link({ href, tokens, autolink }) {
        const attribute = autolink ? href.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : href.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<a href="${attribute}"${autolink ? ' data-brain-export-autolink=""' : ""}>${this.parser.parseInline(tokens)}</a>`;
      } } } : {}),
      walkTokens: async (token) => {
      if (token.type === "image" && options.localSvg) {
        const inline = await options.localSvg(token.href);
        if (inline) token.href = inline;
      }
      if (token.type !== "code") return;
      const number = ++fence;
      const language = (token.lang ?? "").split(/\s/)[0];
      try {
        const renderer = await options.rendererFor?.(language);
        if (!renderer || renderer.needsBrowser) return;
        const html = await renderer.toStatic(token.text, { theme: "print", ...(options.path ? { path: options.path } : {}) });
        if (typeof html !== "string" || lintDocument(buildHtmlDocument({ content: html, contentType: "html" })).some((warning) => warning.code === "script" || warning.code === "network-resource" || warning.code === "remote-image")) throw new Error("static output contains script or an external resource");
        Object.assign(token, { type: "html", text: html, block: true });
      } catch (error) {
        warnings.push({ code: "static-renderer", message: `Fence ${number} (${language || "unlabelled"}) retained as code: ${error instanceof Error ? error.message : String(error)}` });
      }
    } });
    content = await parser.parse(content);
  }
  const html = buildDocument(opts, opts.contentType === "markdown" ? content : undefined);
  return { html, warnings: [...warnings, ...lintDocument(html)] };
}
