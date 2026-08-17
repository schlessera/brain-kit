import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

/** What `content` holds — markdown to parse, or HTML to pass through. */
export type RenderContentType = "markdown" | "html";

const STYLES = `
  :root {
    color-scheme: light;
    --bg: #ffffff;
    --fg: #1f2937;
    --muted: #6b7280;
    --border: #e5e7eb;
    --surface: #f8fafc;
    --primary: #2563eb;
    --code-bg: #f3f4f6;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif, "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji";
    color: var(--fg);
    font-size: 16px;
    line-height: 1.6;
    padding: 28px 32px;
    word-wrap: break-word;
  }
  h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin: 1.4em 0 0.6em; color: var(--fg); }
  h1 { font-size: 1.75em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
  h3 { font-size: 1.2em; }
  h4 { font-size: 1.05em; }
  p { margin: 0.7em 0; }
  a { color: var(--primary); text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul, ol { padding-left: 1.6em; margin: 0.6em 0; }
  li { margin: 0.2em 0; }
  blockquote {
    margin: 0.8em 0;
    padding: 0.4em 1em;
    border-left: 3px solid var(--border);
    color: var(--muted);
    background: var(--surface);
    border-radius: 0 6px 6px 0;
  }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.9em;
    background: var(--code-bg);
    padding: 0.15em 0.35em;
    border-radius: 4px;
  }
  pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.8em 1em;
    overflow-x: auto;
    font-size: 0.88em;
    line-height: 1.5;
  }
  pre code { background: transparent; padding: 0; border-radius: 0; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 1.6em 0; }
  table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
  th, td { border: 1px solid var(--border); padding: 0.45em 0.7em; text-align: left; }
  th { background: var(--surface); font-weight: 600; }
  img { max-width: 100%; height: auto; }
  /* Mermaid diagrams arrive pre-rendered as inline SVG (the page runs no JS) */
  .mermaid-figure { margin: 1em 0; text-align: center; }
  .mermaid-figure svg { max-width: 100%; height: auto; }
  .remote-image {
    display: inline-block; padding: 2px 8px; border: 1px dashed #b0b0b0;
    border-radius: 4px; color: #6b6b6b; font-size: 0.9em;
  }
  /* Keep cards and table rows from splitting across printed pages */
  @media print {
    table, blockquote, pre, .mermaid-figure { break-inside: avoid; }
    h1, h2, h3, h4 { break-after: avoid; }
  }
  /* Trim trailing whitespace at the bottom so screenshots crop tightly */
  body > *:last-child { margin-bottom: 0; }
  body > *:first-child { margin-top: 0; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The renderer denies the page all network access by default (see
 * @schlessera/brain-render-puppeteer), so a remote `<img>` would silently render
 * as a broken-image box. Replace those with a visible, honest placeholder —
 * inlined `data:` images still render normally.
 *
 * `allowHosts` mirrors the renderer's own host allowlist: an image whose host
 * the renderer will actually resolve is left alone. Passing hosts here without
 * passing the same list to the renderer produces broken images, not
 * placeholders — the two lists belong together.
 */
function placeholderRemoteImages(html: string, allowHosts: string[]): string {
  const allowed = new Set(allowHosts.map((h) => h.toLowerCase()));
  // Attributes are consumed quote-aware rather than as `[^>]*`: an earlier
  // attribute may legitimately contain `>` (`alt="<b>x</b>"`), and a bare
  // `[^>]*` would end the match there, letting the image slip through
  // unplaceholdered and render as a broken-image box.
  return html.replace(
    /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi,
    (tag, attrs: string) => {
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const value = src?.[1] ?? src?.[2];
      if (!value) return tag;
      if (/^data:/i.test(value)) return tag;
      const host = hostOf(value);
      if (host && allowed.has(host)) return tag;
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const label = alt?.[1] ?? alt?.[2];
      return `<span class="remote-image">[${label ? escapeHtml(label) : "remote image"} — not embedded]</span>`;
    }
  );
}

export interface BuildHtmlDocumentOptions {
  content: string;
  contentType: RenderContentType;
  title?: string;
  /**
   * Image hosts the renderer has been told to resolve. Images on these hosts
   * survive; every other remote image becomes a placeholder. Default: none.
   */
  allowHosts?: string[];
}

/**
 * Wrap markdown or HTML in the shared print-ready document shell.
 *
 * The same function backs the UI's `/api/render` and the CLI's `brain render`,
 * so a page shared from the app and a PDF produced on the command line are
 * byte-identical for identical input.
 */
export function buildHtmlDocument(opts: BuildHtmlDocumentOptions): string {
  const rendered =
    opts.contentType === "markdown"
      ? (marked.parse(opts.content, { async: false }) as string)
      : opts.content;
  const inner = placeholderRemoteImages(rendered, opts.allowHosts ?? []);
  const title = opts.title ?? "Shared from Brain";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>${inner}</body>
</html>`;
}
