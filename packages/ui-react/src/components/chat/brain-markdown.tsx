import { API_BASE } from "../../lib/backend.js";
import React, { useEffect, useMemo, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  classifyRepoPath,
  isInternalRepoDir,
  isInternalRepoPath,
  useFileStore,
} from "../../stores/file-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { ShareBlock, type ShareBlockFormat } from "./share-block.js";
import { CopyButton } from "./copy-button.js";
import { ZoomableImage } from "../images/zoomable-image.js";
import { MermaidBlock } from "./mermaid-block.js";

const ENTITY_TAGS: Record<string, string> = {
  co: "entity-co",
  p: "entity-p",
  proj: "entity-proj",
  ev: "entity-ev",
  d: "entity-d",
  st: "entity-st",
  f: "entity-f",
};

// Use a unicode marker that won't appear in normal text to wrap entities
// so they survive markdown parsing without relying on rehypeRaw
const ENTITY_START = "\u200B\u200B"; // zero-width spaces as delimiter
const ENTITY_SEP = "\u200B";
const ENTITY_END = "\u200B\u200B\u200B";

function renderEntityTags(md: string): string {
  // Convert entity tags to marker-based format:
  //   START tag SEP content END  (START/SEP/END are ZWSP runs, see above)
  let result = md.replace(
    /<(co|p|proj|ev|d|st|f)>([\s\S]*?)<\/\1>/g,
    (_match, tag, content) => `${ENTITY_START}${tag}${ENTITY_SEP}${content}${ENTITY_END}`
  );
  // Clean up any orphaned/unmatched entity tags
  result = result.replace(/<\/?(?:co|p|proj|ev|d|st|f)>/g, "");

  // Log and strip any remaining non-standard HTML-like tags the LLM may have output
  result = result.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) => {
    const allowed = [
      "span", "strong", "em", "b", "i", "a", "br", "hr", "p",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "code", "pre", "blockquote",
      "table", "thead", "tbody", "tr", "th", "td",
      "div", "img", "del", "sup", "sub",
    ];
    if (allowed.includes(tag.toLowerCase())) return match;
    console.warn("[entity-tags] Stripping unrecognized tag:", match);
    return "";
  });

  return result;
}

/**
 * Turn a markdown image source into something the browser can actually load.
 *
 * Anything already absolute — a `data:` URI, an http(s) URL, or a path that is
 * already an API route — passes through. A repo-relative path is rewritten to
 * the files endpoint, which is where brain content is served from.
 */
export function repoImageSrc(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) return src;
  if (/^(data:|blob:|https?:\/\/)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/api/")) return trimmed;
  const rel = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
  return `${API_BASE}/files/content?path=${encodeURIComponent(rel)}&raw=1`;
}

/**
 * Parse entity markers in a text string. Each entity content is run through
 * `innerTransform` so file-path linkification (or any other inline transform)
 * applies inside `<f>...</f>` spans too.
 */
function renderEntitiesInText(
  text: string,
  innerTransform: (s: string) => React.ReactNode = (s) => s
): React.ReactNode[] {
  const pattern = new RegExp(
    `${ENTITY_START}(co|p|proj|ev|d|st|f)${ENTITY_SEP}(.*?)${ENTITY_END}`,
    "g"
  );
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(innerTransform(text.slice(lastIndex, match.index)));
    }
    const cls = ENTITY_TAGS[match[1]] || "";
    nodes.push(
      <span key={key++} className={cls}>
        {innerTransform(match[2])}
      </span>
    );
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(innerTransform(text.slice(lastIndex)));
  }
  return nodes;
}

/** Concatenate all text descendants of a React node tree. */
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/**
 * If a <pre>'s children are a ```mermaid / ```mmd fence, recover the raw
 * diagram source. Text is extracted recursively because rehype-highlight
 * and the linkify pass may have wrapped parts of it in elements.
 */
function mermaidSourceFrom(children: React.ReactNode): string | null {
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement(child)) continue;
    const props = child.props as { className?: string; children?: React.ReactNode };
    if (typeof props.className === "string" && /\blanguage-(?:mermaid|mmd)\b/.test(props.className)) {
      return extractText(props.children).replace(/\n$/, "");
    }
  }
  return null;
}

function MarkdownPre({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  const mermaid = mermaidSourceFrom(children);
  if (mermaid !== null) return <MermaidBlock source={mermaid} />;
  return <CodePre {...props}>{children}</CodePre>;
}

function CodePre({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group relative">
      <pre
        ref={ref}
        className="overflow-x-auto rounded-lg border border-border bg-surface p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed"
        {...props}
      >
        {children}
      </pre>
      <CopyButton getText={() => ref.current?.textContent ?? ""} />
    </div>
  );
}

function MarkdownTable({ children, ...props }: React.ComponentPropsWithoutRef<"table">) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table {...props}>{children}</table>
    </div>
  );
}

interface BrainMarkdownProps {
  content: string;
  className?: string;
  entityTags?: boolean;
  fileLinks?: boolean;
}

type ShareSegment = { kind: "share"; format: ShareBlockFormat; title?: string; body: string };
type TextSegment = { kind: "text"; text: string };
type Segment = TextSegment | ShareSegment;

const SHARE_BLOCK_RE = /<share\b([^>]*)>([\s\S]*?)<\/share>/gi;
const VALID_FORMATS: ReadonlySet<ShareBlockFormat> = new Set([
  "image",
  "pdf",
  "text",
  "markdown",
  "richtext",
]);

function parseShareAttrs(raw: string): { format: ShareBlockFormat; title?: string } {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  const format = (attrs.format ?? "image").toLowerCase() as ShareBlockFormat;
  return {
    format: VALID_FORMATS.has(format) ? format : "image",
    title: attrs.title,
  };
}

function splitShareBlocks(input: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SHARE_BLOCK_RE.lastIndex = 0;
  while ((m = SHARE_BLOCK_RE.exec(input)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", text: input.slice(last, m.index) });
    }
    const { format, title } = parseShareAttrs(m[1] ?? "");
    out.push({ kind: "share", format, title, body: m[2].trim() });
    last = SHARE_BLOCK_RE.lastIndex;
  }
  if (last < input.length) {
    out.push({ kind: "text", text: input.slice(last) });
  }
  return out;
}

/** Wrap any element's render to process entity markers + file paths in its text children */
function withTextProcessing<T extends keyof React.JSX.IntrinsicElements>(
  Tag: T,
  opts: { entityTags: boolean; fileLinks: boolean }
) {
  return ({ children, ...props }: React.ComponentPropsWithoutRef<T> & { children?: React.ReactNode }) => (
    React.createElement(Tag, props as any, processChildText(children, opts))
  );
}

export function BrainMarkdown({ content, className, entityTags = false, fileLinks = false }: BrainMarkdownProps) {
  const segments = splitShareBlocks(content);
  if (segments.length > 1 || (segments.length === 1 && segments[0].kind === "share")) {
    return (
      <>
        {segments.map((seg, i) =>
          seg.kind === "share" ? (
            <ShareBlock key={i} body={seg.body} format={seg.format} title={seg.title} />
          ) : seg.text.trim() ? (
            <BrainMarkdownInner
              key={i}
              content={seg.text}
              className={className}
              entityTags={entityTags}
              fileLinks={fileLinks}
            />
          ) : null
        )}
      </>
    );
  }
  return (
    <BrainMarkdownInner
      content={content}
      className={className}
      entityTags={entityTags}
      fileLinks={fileLinks}
    />
  );
}

function BrainMarkdownInner({ content, className, entityTags = false, fileLinks = false }: BrainMarkdownProps) {
  const processed = entityTags ? renderEntityTags(content) : content;
  const ensureWikilinks = useFileStore((s) => s.ensureWikilinks);

  useEffect(() => {
    if (fileLinks) void ensureWikilinks();
  }, [fileLinks, ensureWikilinks]);

  // Memoized so component identities are stable across the per-token
  // re-renders of a streaming message. Inline arrows here would be a new
  // component type every render, forcing React to unmount and remount every
  // block — which would destroy MermaidBlock's rendered-SVG state mid-stream.
  const components = useMemo(() => {
    const opts = { entityTags, fileLinks };
    // Override block/inline elements that can contain text. We need to do this
    // whenever either entityTags or fileLinks is enabled so we can scan text nodes.
    const textComponents = entityTags || fileLinks
      ? {
          p: withTextProcessing("p", opts),
          li: withTextProcessing("li", opts),
          strong: withTextProcessing("strong", opts),
          em: withTextProcessing("em", opts),
          h1: withTextProcessing("h1", opts),
          h2: withTextProcessing("h2", opts),
          h3: withTextProcessing("h3", opts),
          h4: withTextProcessing("h4", opts),
          td: withTextProcessing("td", opts),
          th: withTextProcessing("th", opts),
          // Paths and wikilinks frequently appear inside inline code spans
          // in brain notes (e.g. `talks/_index.md`). Process code elements
          // too. Note: this also linkifies paths inside fenced code blocks,
          // which is harmless in the brain UI context (paths in shell
          // snippets remain clickable). The known downside is that literal
          // `[[slug]]` syntax shown for teaching purposes will attempt to
          // resolve as a wikilink.
          code: withTextProcessing("code", opts),
        }
      : {};
    return {
      ...textComponents,
      pre: MarkdownPre,
      table: MarkdownTable,
      /**
       * An image the agent wrote into the brain is referenced by its repo path
       * (`![](assets/images/x.png)`), which the browser would resolve against
       * the app origin and 404 — the bytes live behind the files API. Rewrite
       * repo-relative sources to that endpoint so a generated image actually
       * appears. `data:` URIs and absolute URLs are left alone.
       */
      img: ({ src, alt, ...props }: React.ComponentPropsWithoutRef<"img">) => {
        const resolved = typeof src === "string" ? repoImageSrc(src) : src;
        // Inline, an image is only as wide as the viewport. Tapping it opens the
        // zoom viewer, the same way a mermaid diagram does.
        if (typeof resolved !== "string") {
          return <img {...props} alt={alt ?? ""} loading="lazy" className="my-2 max-w-full rounded" />;
        }
        return (
          <ZoomableImage
            src={resolved}
            alt={alt}
            className="my-2 max-w-full cursor-zoom-in rounded"
            imgProps={{ ...props, loading: "lazy" }}
          />
        );
      },
      a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a">) => {
        if (fileLinks) {
          const kind = classifyRepoPath(href);
          if (kind === "file") {
            return <FileLink path={href as string}>{children}</FileLink>;
          }
          if (kind === "dir") {
            return <DirLink path={href as string}>{children}</DirLink>;
          }
        }
        return (
          <a target="_blank" rel="noopener noreferrer" href={href} {...props}>
            {children}
          </a>
        );
      },
    };
  }, [entityTags, fileLinks]);

  return (
    <div className={className ?? "brain-prose"}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={entityTags ? [] : [rehypeHighlight]}
        components={components}
      >
        {processed}
      </Markdown>
    </div>
  );
}

/** Click target for a repo-relative file reference. Opens the file panel + viewer. */
export function FileLink({ path, children }: { path: string; children?: React.ReactNode }) {
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  return (
    <a
      href={`#/files/${path}`}
      onClick={(e) => {
        e.preventDefault();
        setFilePanelOpen(true);
        void openFile(path);
      }}
      className="brain-file-link"
      title={path}
    >
      {children ?? path}
    </a>
  );
}

/**
 * Resolve an obsidian-style `[[target]]` to a repo-relative path using the
 * wikilink map. Targets containing `/` are treated as paths directly; bare
 * slugs are looked up by basename. An `#anchor` suffix is stripped before
 * lookup.
 */
function resolveWikilinkTarget(
  raw: string,
  slugMap: Record<string, string>
): string | null {
  const hashIdx = raw.indexOf("#");
  const noAnchor = hashIdx >= 0 ? raw.slice(0, hashIdx).trim() : raw.trim();
  if (!noAnchor) return null;
  if (noAnchor.includes("/")) {
    if (noAnchor.endsWith("/")) return null;
    return /\.[a-z0-9]{1,8}$/i.test(noAnchor) ? noAnchor : `${noAnchor}.md`;
  }
  return slugMap[noAnchor.toLowerCase()] ?? null;
}

/** Click target for `[[slug]]` / `[[slug|Label]]`. */
export function WikiLink({
  target,
  label,
}: {
  target: string;
  label?: string;
}) {
  const slugMap = useFileStore((s) => s.wikilinkMap);
  const loaded = useFileStore((s) => s.wikilinkLoaded);
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);

  const resolved = resolveWikilinkTarget(target, slugMap);
  const display = label ?? target;

  if (!resolved) {
    return (
      <span
        className="brain-wiki-link brain-wiki-link--unresolved"
        title={loaded ? `Unresolved wikilink: ${target}` : "Resolving…"}
      >
        {display}
      </span>
    );
  }

  return (
    <a
      href={`#/files/${resolved}`}
      onClick={(e) => {
        e.preventDefault();
        setFilePanelOpen(true);
        void openFile(resolved);
      }}
      className="brain-file-link brain-wiki-link"
      title={resolved}
    >
      {display}
    </a>
  );
}

/**
 * Click target for a repo-relative directory reference. Opens the file
 * panel, expands the tree down to the directory, and highlights it so
 * the user sees its contents.
 */
export function DirLink({ path, children }: { path: string; children?: React.ReactNode }) {
  const openDir = useFileStore((s) => s.openDir);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const trimmed = path.replace(/\/+$/, "");
  const display = `${trimmed}/`;
  return (
    <a
      href={`#/files/${display}`}
      onClick={(e) => {
        e.preventDefault();
        setFilePanelOpen(true);
        void openDir(trimmed);
      }}
      className="brain-file-link brain-file-link--dir"
      title={display}
    >
      {children ?? display}
    </a>
  );
}

// Bare-path tokens in prose. Three passes:
//  - files:     "notes/projects/foo.md"           — ends with .ext
//  - dirs:      "notes/projects/post-templates/"  — ends with /
//  - wikilinks: "[[slug]]" or "[[slug|Display]]"  — obsidian-style
const BARE_FILE_RE =
  /\b([a-z][a-z0-9_-]*(?:\/[a-z0-9._-]+)+\.[a-z0-9]{1,8})\b/gi;
const BARE_DIR_RE =
  /\b([a-z][a-z0-9_-]*(?:\/[a-z0-9._-]+)+\/)(?=$|[\s,;:!?)\]])/gi;
const WIKILINK_RE = /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

interface PathMatch {
  start: number;
  end: number;
  kind: "file" | "dir" | "wikilink";
  /** For file/dir kinds. */
  path?: string;
  /** Raw target inside the brackets (may include `#anchor`). For wikilink. */
  target?: string;
  /** Display label override (after the pipe). For wikilink. */
  label?: string;
}

function scanBarePaths(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  BARE_FILE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_FILE_RE.exec(text)) !== null) {
    if (isInternalRepoPath(m[1])) {
      out.push({
        start: m.index,
        end: BARE_FILE_RE.lastIndex,
        path: m[1],
        kind: "file",
      });
    }
  }
  BARE_DIR_RE.lastIndex = 0;
  while ((m = BARE_DIR_RE.exec(text)) !== null) {
    if (isInternalRepoDir(m[1])) {
      out.push({
        start: m.index,
        end: BARE_DIR_RE.lastIndex,
        path: m[1],
        kind: "dir",
      });
    }
  }
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: WIKILINK_RE.lastIndex,
      kind: "wikilink",
      target: m[1].trim(),
      label: m[2]?.trim(),
    });
  }
  out.sort((a, b) => a.start - b.start);

  // Drop overlapping matches — keep the first (earlier) when ranges collide
  const merged: PathMatch[] = [];
  let cursor = 0;
  for (const cand of out) {
    if (cand.start >= cursor) {
      merged.push(cand);
      cursor = cand.end;
    }
  }
  return merged;
}

function renderBarePathsInText(text: string): React.ReactNode[] {
  const matches = scanBarePaths(text);
  if (matches.length === 0) return [text];
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of matches) {
    if (m.start > last) nodes.push(text.slice(last, m.start));
    if (m.kind === "file" && m.path) {
      nodes.push(
        <FileLink key={`p${key++}`} path={m.path}>
          {m.path}
        </FileLink>
      );
    } else if (m.kind === "dir" && m.path) {
      nodes.push(
        <DirLink key={`p${key++}`} path={m.path.replace(/\/+$/, "")}>
          {m.path}
        </DirLink>
      );
    } else if (m.kind === "wikilink" && m.target) {
      nodes.push(
        <WikiLink key={`p${key++}`} target={m.target} label={m.label} />
      );
    }
    last = m.end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Public helper: turn any raw text blob into React nodes with bare-path
 * tokens replaced by FileLink elements. Use this in non-markdown surfaces
 * (tool outputs, streaming logs, plain user text).
 */
export function linkifyPaths(text: string): React.ReactNode {
  if (!text) return text;
  const parts = renderBarePathsInText(text);
  if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
  return <>{parts}</>;
}

/** Process a text string for entity markers and/or bare file paths. */
function transformTextString(
  text: string,
  opts: { entityTags: boolean; fileLinks: boolean }
): React.ReactNode {
  const linkify = opts.fileLinks
    ? (s: string): React.ReactNode => {
        if (!s) return s;
        const parts = renderBarePathsInText(s);
        if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
        return <>{parts}</>;
      }
    : (s: string): React.ReactNode => s;

  if (opts.entityTags && text.includes(ENTITY_START)) {
    return <>{renderEntitiesInText(text, opts.fileLinks ? (s) => linkify(s) : undefined)}</>;
  }

  return linkify(text);
}

/** Recursively process React children to expand entity markers / file paths in text nodes */
function processChildText(children: React.ReactNode, opts: { entityTags: boolean; fileLinks: boolean }): React.ReactNode {
  if (typeof children === "string") {
    return transformTextString(children, opts);
  }
  if (Array.isArray(children)) {
    return children.map((child, i) =>
      typeof child === "string"
        ? <React.Fragment key={i}>{transformTextString(child, opts)}</React.Fragment>
        : child
    );
  }
  return children;
}
