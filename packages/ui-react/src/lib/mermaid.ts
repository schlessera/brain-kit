/**
 * Mermaid runtime + fence helpers.
 *
 * Mermaid is ~2MB, so it loads on first use via dynamic import; nothing here
 * pulls it in at module scope. Rendering is tolerant of partial sources
 * (streaming deltas): parse is gated and every failure resolves to null
 * instead of throwing, so callers keep the previous good SVG. Results are
 * cached per (theme, source), which makes the per-token re-render of a
 * streaming message a cache hit.
 */

import { mermaidThemeVariables, type MermaidTheme } from "./mermaid-theme.js";

export type { MermaidTheme };

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => mod.default);
  }
  return mermaidPromise;
}

/** Config shared by both themes; only `themeVariables` differs per render. */
function baseConfig(theme: MermaidTheme) {
  return {
    startOnLoad: false,
    // "strict" sanitizes label HTML and blocks script/click payloads —
    // diagram sources arrive from the model and from repo files.
    securityLevel: "strict" as const,
    // Never inject mermaid's own error SVG into the document; failures
    // surface as a null render result and the caller shows the source.
    suppressErrorRendering: true,
    theme: "base" as const,
    themeVariables: mermaidThemeVariables(theme),
  };
}

/**
 * Renders are serialized through this chain because the theme is applied by
 * re-calling mermaid.initialize(), which mutates GLOBAL config — a dark
 * in-app render and a light share render would otherwise race and one would
 * come out in the other's palette.
 *
 * The obvious alternative, a per-diagram `%%{init: …}%%` directive, does not
 * work: mermaid rewrites every `'` to `"` before JSON.parse-ing a directive
 * (chunk-NSK5VX7P), so a quoted font stack makes the whole directive
 * unparseable and it is silently dropped; and its themeVariables sanitizer
 * rejects any value outside /^[\\d "#%(),.;A-Za-z]+$/, which blanks every
 * hyphenated CSS keyword (`system-ui`, `-apple-system`). A dropped directive
 * fails SILENTLY — the diagram renders in whatever the last global config
 * was — so this path is not worth the theming it appears to buy.
 */
let renderChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderChain.then(fn, fn);
  renderChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const svgCache = new Map<string, string>();
const CACHE_MAX = 100;
let renderSeq = 0;

function cacheKey(source: string, theme: MermaidTheme): string {
  return `${theme}\u0000${source}`;
}

/** Synchronous cache lookup, so a remounted block can show its SVG without a flash. */
export function peekMermaidSvg(source: string, theme: MermaidTheme = "dark"): string | null {
  return svgCache.get(cacheKey(source.trim(), theme)) ?? null;
}

/**
 * Render a mermaid source to SVG markup. Resolves null when the source does
 * not parse (e.g. an incomplete streaming fence) or rendering fails — never
 * throws and never mutates the document beyond mermaid's temp container.
 */
export async function renderMermaidSvg(
  source: string,
  theme: MermaidTheme = "dark"
): Promise<string | null> {
  const trimmed = source.trim();
  if (!trimmed) return null;
  const key = cacheKey(trimmed, theme);
  const hit = svgCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const mermaid = await loadMermaid();
    return await serialized(async () => {
      // Re-check inside the lock: an identical render may have been queued
      // ahead of this one while both were waiting.
      const queued = svgCache.get(key);
      if (queued !== undefined) return queued;
      mermaid.initialize(baseConfig(theme));
      const ok = await mermaid.parse(trimmed, { suppressErrors: true });
      if (!ok) return null;
      const { svg } = await mermaid.render(`brain-mermaid-${++renderSeq}`, trimmed);
      if (svgCache.size >= CACHE_MAX) {
        const oldest = svgCache.keys().next().value;
        if (oldest !== undefined) svgCache.delete(oldest);
      }
      svgCache.set(key, svg);
      return svg;
    });
  } catch {
    return null;
  }
}

export interface MermaidFence {
  /** Offset of the opening fence line start. */
  start: number;
  /** Offset just past the closing fence line (and its newline, if present). */
  end: number;
  /** Diagram source between the fences, without the trailing newline. */
  source: string;
  /** Leading spaces of the opening fence line (a list-indented fence). */
  indent: string;
}

const FENCE_LINE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Find every *closed* ```mermaid fence in a markdown string. A line scanner
 * (not a regex over the whole text) so mermaid fences nested inside other
 * code blocks are not matched, and an unterminated streaming fence is simply
 * not returned.
 */
export function findMermaidFences(md: string): MermaidFence[] {
  const out: MermaidFence[] = [];
  const lines = md.split("\n");
  let offset = 0;
  let open: {
    char: string;
    len: number;
    mermaid: boolean;
    start: number;
    contentStart: number;
    indent: string;
  } | null = null;

  for (const line of lines) {
    const lineEnd = Math.min(offset + line.length + 1, md.length);
    const m = FENCE_LINE_RE.exec(line);
    if (open) {
      if (m && m[2][0] === open.char && m[2].length >= open.len && m[3].trim() === "") {
        if (open.mermaid) {
          out.push({
            start: open.start,
            end: lineEnd,
            source: md.slice(open.contentStart, offset).replace(/\n$/, ""),
            indent: open.indent,
          });
        }
        open = null;
      }
    } else if (m) {
      const info = m[3].trim();
      // A backtick fence's info string may not contain backticks (CommonMark).
      if (!(m[2][0] === "`" && info.includes("`"))) {
        const lang = info.split(/\s+/)[0]?.toLowerCase() ?? "";
        open = {
          char: m[2][0],
          len: m[2].length,
          mermaid: lang === "mermaid" || lang === "mmd",
          start: offset,
          contentStart: lineEnd,
          indent: m[1],
        };
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/**
 * Replace each closed mermaid fence via `replacement`; returning null keeps
 * the fence verbatim. Pure — rendering is injected, so this is unit-testable
 * without a DOM.
 */
export function replaceMermaidFences(
  md: string,
  replacement: (fence: MermaidFence, index: number) => string | null
): string {
  const fences = findMermaidFences(md);
  let out = md;
  for (let i = fences.length - 1; i >= 0; i--) {
    const r = replacement(fences[i], i);
    if (r == null) continue;
    out = out.slice(0, fences[i].start) + r + out.slice(fences[i].end);
  }
  return out;
}

/**
 * Inline every closed mermaid fence as a pre-rendered `<div class="mermaid-figure"><svg…>`
 * block. Used by the share pipeline: the PNG/PDF renderer runs the page with
 * JavaScript disabled and all network denied, so the diagram must already be
 * SVG by the time the markdown reaches the server. Defaults to the light
 * theme to match the share template. Fences that fail to render are
 * left as code fences — the pre-feature behavior.
 */
/**
 * The server's render route caps `content` at 512 KiB. Inlining can expand a
 * few-hundred-byte fence into a multi-kilobyte SVG, so stay safely below the
 * cap and leave any fence that would cross it as source — a shared code block
 * beats a rejected request.
 */
const INLINE_BUDGET_CHARS = 480_000;

/** Pure inlining step: substitute pre-rendered SVGs (by fence index) under the budget. */
export function inlineRenderedFences(
  md: string,
  rendered: (string | null)[],
  budget: number = INLINE_BUDGET_CHARS
): string {
  let total = md.length;
  return replaceMermaidFences(md, (fence, i) => {
    const svg = rendered[i];
    if (!svg) return null;
    // Kept to a single line: marked treats <div> as an HTML block that a
    // blank line would terminate, so newlines inside the SVG must go. The
    // fence's own indentation is preserved so a list-nested fence doesn't
    // break out of its list in the shared document.
    const html = `\n${fence.indent}<div class="mermaid-figure">${svg.replace(/[\r\n]+/g, " ")}</div>\n`;
    const expanded = total + html.length - (fence.end - fence.start);
    if (expanded > budget) return null;
    total = expanded;
    return html;
  });
}

export async function inlineMermaidDiagrams(
  md: string,
  theme: MermaidTheme = "light"
): Promise<string> {
  const fences = findMermaidFences(md);
  if (fences.length === 0) return md;
  const rendered = await Promise.all(fences.map((f) => renderMermaidSvg(f.source, theme)));
  return inlineRenderedFences(md, rendered);
}

const SVG_OPEN_TAG_RE = /<svg\b[^>]*>/i;
const VIEWBOX_RE = /\bviewBox\s*=\s*"\s*[\d.+-]+\s+[\d.+-]+\s+([\d.+-]+)\s+([\d.+-]+)\s*"/i;

/**
 * Give a mermaid SVG an intrinsic pixel size taken from its viewBox.
 *
 * Mermaid ships its diagrams as `style="max-width: Npx"` with no width/height
 * attribute, which is right for a responsive page and wrong for an export: a
 * standalone .svg file then has no intrinsic size, and the PNG/PDF renderer
 * lays it out at the full body width no matter how small the diagram is.
 * Sizing it here is what lets the share page shrink-wrap the figure.
 *
 * Returns the input unchanged when there is no parseable viewBox — an
 * un-sized export beats a corrupted one.
 */
export function sizeSvgForExport(svg: string, maxWidth = 1200): string {
  const open = SVG_OPEN_TAG_RE.exec(svg);
  if (!open) return svg;
  const tag = open[0];
  const vb = VIEWBOX_RE.exec(tag);
  if (!vb) return svg;
  const vbW = Number(vb[1]);
  const vbH = Number(vb[2]);
  if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || vbW <= 0 || vbH <= 0) return svg;
  const width = Math.max(1, Math.min(maxWidth, Math.round(vbW)));
  const height = Math.max(1, Math.round((width / vbW) * vbH));
  const sized = tag
    .replace(/\s(?:width|height|style)\s*=\s*"[^"]*"/gi, "")
    .replace(/<svg\b/i, `<svg width="${width}" height="${height}"`);
  return svg.slice(0, open.index) + sized + svg.slice(open.index + tag.length);
}

/** Whether a repo path is a standalone mermaid source file (previewable as a diagram). */
export function isMermaidPath(path: string): boolean {
  return /\.(mmd|mermaid)$/i.test(path);
}
