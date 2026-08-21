import { useState, type ReactNode } from "react";
import {
  Terminal,
  FileEdit,
  FilePlus,
  FileSearch,
  FolderSearch,
  Search,
  Eye,
  Globe,
  Bot,
  Wand2,
  Braces,
  NotebookPen,
  MapPin,
  ChevronRight,
} from "lucide-react";
import type { ToolCall } from "../../stores/chat-store.js";
import { cn } from "../../lib/utils.js";
import { linkifyPaths, FileLink } from "./brain-markdown.js";
import { MarkdownContent } from "./markdown-content.js";
import { isInternalRepoPath } from "../../stores/file-store.js";
import { GET_LOCATION_TOOL_NAME, normalizeToolName } from "../../lib/tool-names.js";
import { computeDiffRows, type WordToken } from "../../lib/diff.js";

// Re-exported so existing imports of the diff engine from this module keep working.
export { computeDiffRows };

// ============================================================
// Shared helpers
// ============================================================

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function basename(p: string): string {
  return p.replace(/^.*\//, "");
}

/**
 * Tool inputs carry absolute paths (`/data/brain/notes/foo.md`); the file
 * panel wants repo-relative ones. Strip everything up to the brain repo root
 * and verify the result actually looks like a repo path.
 */
export function toRepoRelative(path: string): string | null {
  // isInternalRepoPath is a `href is string` guard; feed it a widened local
  // so the original string parameter is not narrowed to `never`.
  const candidate: string | undefined = path;
  if (isInternalRepoPath(candidate)) return candidate;
  const idx = path.indexOf("/brain/");
  if (idx >= 0) {
    const rel: string | undefined = path.slice(idx + "/brain/".length);
    if (isInternalRepoPath(rel)) return rel;
  }
  return null;
}

/** Path as a clickable file link when it resolves inside the brain repo. */
function fileLabel(path: string): ReactNode {
  const rel = toRepoRelative(path);
  if (rel) return <FileLink path={rel}>{rel}</FileLink>;
  return <span title={path}>{path}</span>;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

// ============================================================
// Header helpers: icon, summary, meta badge
// ============================================================

const toolIcons: Record<string, typeof Terminal> = {
  Bash: Terminal,
  Edit: FileEdit,
  Write: FilePlus,
  NotebookEdit: NotebookPen,
  Read: Eye,
  Grep: FileSearch,
  Glob: FolderSearch,
  WebSearch: Search,
  WebFetch: Globe,
  Agent: Bot,
  Skill: Wand2,
  LSP: Braces,
  [GET_LOCATION_TOOL_NAME]: MapPin,
};

export function getToolIcon(name: string): typeof Terminal {
  return toolIcons[normalizeToolName(name)] || Terminal;
}

/**
 * Display name for a tool. In-process MCP tools stream as
 * `mcp__<server>__<tool>`; show just the bare tool name in the timeline.
 */
export function getToolLabel(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[parts.length - 1] || name;
  }
  return name;
}

/** Extract a short inline summary from tool input for at-a-glance context. */
export function getToolSummary(tool: ToolCall): string | null {
  const inp = tool.input;
  if (!inp) return null;
  switch (tool.name) {
    case "Agent":
      return str(inp.description);
    case "Bash":
      // The human-phrased description reads better than a truncated command
      return str(inp.description) ?? str(inp.command)?.slice(0, 80) ?? null;
    case "Read": {
      const path = str(inp.file_path);
      if (!path) return null;
      const offset = num(inp.offset);
      const limit = num(inp.limit);
      if (offset !== null && limit !== null) {
        return `${basename(path)} · ${offset}–${offset + limit}`;
      }
      return basename(path);
    }
    case "Edit":
    case "Write":
      return str(inp.file_path) ? basename(inp.file_path as string) : null;
    case "NotebookEdit":
      return str(inp.notebook_path) ? basename(inp.notebook_path as string) : null;
    case "Glob":
    case "Grep":
      return str(inp.pattern);
    case "WebSearch":
      return str(inp.query);
    case "WebFetch": {
      const url = str(inp.url);
      if (!url) return null;
      try {
        const u = new URL(url);
        return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
      } catch {
        return url;
      }
    }
    case "Skill":
      return [str(inp.skill), str(inp.args)].filter(Boolean).join(" ") || null;
    case "LSP": {
      const op = str(inp.operation) ?? str(inp.method) ?? str(inp.action);
      const path = str(inp.file_path);
      return [op, path && basename(path)].filter(Boolean).join(" · ") || null;
    }
    default:
      return null;
  }
}

/** Right-side header meta: output size + wall-clock duration. */
export function getOutputMeta(tool: ToolCall): string | null {
  const parts: string[] = [];
  if (tool.output && !tool.isError) {
    const lines = countLines(tool.output.trimEnd());
    switch (tool.name) {
      case "Grep":
        parts.push(
          /no matches/i.test(tool.output) ? "no matches" : `${lines} matches`
        );
        break;
      case "Glob":
        parts.push(
          /no files/i.test(tool.output)
            ? "no files"
            : `${lines} file${lines === 1 ? "" : "s"}`
        );
        break;
      case "Read":
        parts.push(`${lines} lines`);
        break;
      default:
        if (lines > 5) parts.push(`${lines} lines`);
    }
  }
  if (tool.startedAt && tool.endedAt && tool.endedAt > tool.startedAt) {
    parts.push(formatDuration(tool.endedAt - tool.startedAt));
  }
  return parts.length ? parts.join(" · ") : null;
}

/** File a tool writes to — used for the "N files touched" group summary. */
export function getTouchedFile(tool: ToolCall): string | null {
  if (tool.name === "Edit" || tool.name === "Write") {
    return str(tool.input?.file_path);
  }
  if (tool.name === "NotebookEdit") {
    return str(tool.input?.notebook_path);
  }
  return null;
}

// ============================================================
// Input views
// ============================================================

export function ToolInputView({ tool }: { tool: ToolCall }) {
  // Input JSON still streaming in — a partial JSON dump is noise
  if (tool.status === "streaming") {
    return (
      <div className="flex items-center gap-2 rounded-md bg-background/60 p-2 text-[11px] text-muted-foreground/60">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
          style={{ animation: "breathe 1.5s ease-in-out infinite" }}
        />
        Preparing input…
      </div>
    );
  }

  switch (tool.name) {
    case "Edit":
      if (str(tool.input?.old_string) !== null && str(tool.input?.new_string) !== null) {
        return <EditDiffView tool={tool} />;
      }
      break;
    case "Write":
      if (str(tool.input?.content) !== null) {
        return <WriteFileView tool={tool} />;
      }
      break;
    case "Bash":
      if (str(tool.input?.command) !== null) {
        return <BashCommandView tool={tool} />;
      }
      break;
    case "Read":
      if (str(tool.input?.file_path) !== null) {
        return <ReadInputView tool={tool} />;
      }
      break;
  }
  return <KeyValueView tool={tool} />;
}

function PathHeader({ path, badge }: { path: string | null; badge?: string | null }) {
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-raised/50 px-2 py-1.5 font-[family-name:var(--font-mono)] text-[11px]">
      <span className="min-w-0 truncate text-foreground/80">
        {path ? fileLabel(path) : "unknown file"}
      </span>
      {badge && (
        <span className="ml-auto shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
          {badge}
        </span>
      )}
    </div>
  );
}

/** Render a diff line, emphasizing changed word tokens when refined. */
function DiffLine({ tokens, line, changedClass }: {
  tokens: WordToken[] | null;
  line: string;
  changedClass: string;
}) {
  if (!tokens) return <>{line}</>;
  return (
    <>
      {tokens.map((t, i) =>
        t.changed ? (
          <span key={i} className={cn("rounded-sm", changedClass)}>
            {t.text}
          </span>
        ) : (
          <span key={i}>{t.text}</span>
        )
      )}
    </>
  );
}

export function EditDiffView({ tool }: { tool: ToolCall }) {
  const rows = computeDiffRows(str(tool.input.old_string) ?? "", str(tool.input.new_string) ?? "");
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <PathHeader
        path={str(tool.input.file_path)}
        badge={tool.input.replace_all ? "replace all" : null}
      />
      <div className="max-h-64 overflow-y-auto bg-background/60 py-1 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
        {rows.map((row, i) => {
          if (row.kind === "same") {
            return (
              <div key={`s${i}`} className="flex">
                <span className="w-5 shrink-0 select-none text-center text-muted-foreground/30"> </span>
                <span className="min-w-0 whitespace-pre-wrap break-all pr-2 text-muted-foreground/70">
                  {row.line}
                </span>
              </div>
            );
          }
          if (row.kind === "del") {
            return (
              <div key={`d${i}`} className="flex bg-red-500/10">
                <span className="w-5 shrink-0 select-none text-center text-red-400/70">-</span>
                <span className="min-w-0 whitespace-pre-wrap break-all pr-2 text-red-200/90">
                  <DiffLine tokens={row.tokens} line={row.line} changedClass="bg-red-500/30" />
                </span>
              </div>
            );
          }
          return (
            <div key={`i${i}`} className="flex bg-emerald-500/10">
              <span className="w-5 shrink-0 select-none text-center text-emerald-400/70">+</span>
              <span className="min-w-0 whitespace-pre-wrap break-all pr-2 text-emerald-200/90">
                <DiffLine tokens={row.tokens} line={row.line} changedClass="bg-emerald-500/30" />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Longest backtick run + 1 so the fence survives content containing fences. */
export function fenceFor(content: string): string {
  const runs = content.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  return "`".repeat(Math.max(3, longest + 1));
}

export function WriteFileView({ tool }: { tool: ToolCall }) {
  const content = str(tool.input.content) ?? "";
  const path = str(tool.input.file_path);
  const ext = path?.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "";
  const fence = fenceFor(content);
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <PathHeader path={path} badge={`${countLines(content)} lines`} />
      <div className="max-h-64 overflow-y-auto [&_pre]:!my-0 [&_pre]:rounded-none [&_pre]:border-0 [&_pre]:bg-background/60 [&_pre]:p-2 [&_pre]:text-[11px]">
        <MarkdownContent content={`${fence}${ext}\n${content}\n${fence}`} />
      </div>
    </div>
  );
}

export function BashCommandView({ tool }: { tool: ToolCall }) {
  const command = str(tool.input.command) ?? "";
  const flags: string[] = [];
  if (tool.input.run_in_background) flags.push("background");
  const timeout = num(tool.input.timeout);
  if (timeout) flags.push(`timeout ${Math.round(timeout / 1000)}s`);
  if (tool.input.dangerouslyDisableSandbox) flags.push("sandbox disabled");
  return (
    <div className="rounded-md bg-background/60 p-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
      <div className="flex gap-1.5">
        <span className="select-none text-primary">$</span>
        <span className="min-w-0 whitespace-pre-wrap break-all text-foreground/90">
          {command}
        </span>
      </div>
      {flags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {flags.map((f) => (
            <span
              key={f}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px]",
                f === "sandbox disabled"
                  ? "bg-destructive/15 text-destructive"
                  : "bg-surface-raised text-muted-foreground"
              )}
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadInputView({ tool }: { tool: ToolCall }) {
  const path = str(tool.input.file_path) ?? "";
  const offset = num(tool.input.offset);
  const limit = num(tool.input.limit);
  const range =
    offset !== null && limit !== null
      ? `lines ${offset}–${offset + limit}`
      : offset !== null
        ? `from line ${offset}`
        : "full file";
  return (
    <div className="flex items-center gap-2 rounded-md bg-background/60 px-2 py-1.5 font-[family-name:var(--font-mono)] text-[11px]">
      <span className="min-w-0 truncate text-foreground/80">{fileLabel(path)}</span>
      <span className="ml-auto shrink-0 text-muted-foreground/60">{range}</span>
    </div>
  );
}

/** Generic structured input: one row per field beats raw JSON for scanning. */
export function KeyValueView({ tool }: { tool: ToolCall }) {
  const entries = Object.entries(tool.input ?? {});
  if (entries.length === 0) {
    return (
      <pre className="overflow-x-auto rounded-md bg-background/60 p-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-muted-foreground">
        {tool.inputJson || "{}"}
      </pre>
    );
  }
  return (
    <div className="space-y-1 rounded-md bg-background/60 p-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
          <span className="shrink-0 text-muted-foreground/50">{key}:</span>
          <span className="max-h-40 min-w-0 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
            {typeof value === "string"
              ? linkifyPaths(value)
              : JSON.stringify(value, null, 1)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Output views
// ============================================================

export function ToolOutputView({ tool }: { tool: ToolCall }) {
  const output = tool.output;
  if (!output) return null;

  if (tool.isError) {
    return <ClampedPre text={output} isError />;
  }

  switch (tool.name) {
    case "Agent":
    case "WebFetch":
      // These outputs are prose (subagent reports, page summaries)
      return (
        <ClampedBox lineLabel={`${countLines(output)} lines`}>
          <div className="rounded-md bg-background/60 p-3 text-[13px]">
            <MarkdownContent content={output} />
          </div>
        </ClampedBox>
      );
    case "Grep":
      return <FileRowsView output={output} pattern={str(tool.input?.pattern)} />;
    case "Glob":
      return <FileRowsView output={output} />;
    case "Read":
      return <ReadOutputStub output={output} />;
    case "WebSearch":
      return <WebSearchResultsView output={output} />;
    default:
      return <ClampedPre text={output} />;
  }
}

/** DOM-safety cap; "Show all" raises it but never renders unbounded output. */
const CLAMP_HARD_CAP = 50_000;
const CLAMP_SHOW_ALL_CAP = 200_000;

export function ClampedPre({ text, isError }: { text: string; isError?: boolean }) {
  const lines = countLines(text.trimEnd());
  const clampable = lines > 16 || text.length > 1600;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? text.slice(0, CLAMP_SHOW_ALL_CAP) : text.slice(0, CLAMP_HARD_CAP);
  return (
    <div>
      <div className={cn("relative", clampable && !showAll && "max-h-56 overflow-hidden")}>
        <pre
          className={cn(
            "overflow-x-auto rounded-md p-2 pr-7 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed",
            isError
              ? "bg-destructive/10 text-destructive"
              : "bg-background/60 text-muted-foreground"
          )}
        >
          {linkifyPaths(shown)}
          {text.length > shown.length && "\n…"}
        </pre>
        {clampable && !showAll && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-md bg-gradient-to-t from-surface to-transparent" />
        )}
      </div>
      {clampable && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mt-1 text-[10px] text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          {showAll ? "Collapse" : `Show all (${lines} lines)`}
        </button>
      )}
    </div>
  );
}

/** Same clamp behavior for arbitrary children (markdown outputs). */
function ClampedBox({ children, lineLabel }: { children: ReactNode; lineLabel: string }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <div>
      <div className={cn("relative", !showAll && "max-h-72 overflow-hidden")}>
        {children}
        {!showAll && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-md bg-gradient-to-t from-surface to-transparent" />
        )}
      </div>
      <button
        type="button"
        onClick={() => setShowAll(!showAll)}
        className="mt-1 text-[10px] text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        {showAll ? "Collapse" : `Show all (${lineLabel})`}
      </button>
    </div>
  );
}

/**
 * Compile a Grep pattern for match highlighting.
 *
 * We run this against every visible row during render, so it must be safe
 * against catastrophic backtracking (ReDoS) — a synchronous `RegExp.exec` can't
 * be interrupted, so a pattern like `(a+)+$` would freeze the UI thread. A
 * pattern that contains no unbounded-repetition operator (`*`, `+`, `{`) cannot
 * backtrack exponentially, so only those compile as real regexes; anything else
 * (and any pattern that fails to compile, e.g. `c++`, `(`) is matched as an
 * escaped literal. Both paths are linear-time. Returns null if even the literal
 * form can't compile, so callers degrade to unhighlighted rows instead of
 * throwing.
 */
export function safeSearchRegex(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  if (!/[*+{]/.test(pattern)) {
    try {
      return new RegExp(pattern, "gi");
    } catch {
      // fall through to the escaped-literal form
    }
  }
  try {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return null;
  }
}

/**
 * Split `text` into alternating non-match / match segments for a global regex.
 * Zero-width matches are skipped (advancing lastIndex) so patterns like `a*`
 * never spin. Purely string-in / segments-out so it's easy to unit test.
 */
export function splitMatches(text: string, re: RegExp): Array<{ text: string; match: boolean }> {
  const segments: Array<{ text: string; match: boolean }> = [];
  re.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    if (guard++ > 10_000) break;
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) segments.push({ text: text.slice(last, m.index), match: false });
    segments.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false });
  return segments;
}

/**
 * Split a ripgrep-style `path:line:content` row into its linkable prefix and
 * the content portion. Returns null when the row has no such prefix (e.g. Glob
 * paths or an unusual format), so the caller can treat the whole line as content.
 */
export function splitGrepRow(line: string): { prefix: string; content: string } | null {
  const m = line.match(/^(.+?:\d+:)([\s\S]*)$/);
  if (!m) return null;
  return { prefix: m[1], content: m[2] };
}

/** Grep/Glob results: one clickable row per line. */
export function FileRowsView({ output, pattern }: { output: string; pattern?: string | null }) {
  const lines = output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  // Degenerate outputs fall back to the plain view
  if (lines.length === 0 || lines.length > 400) {
    return <ClampedPre text={output} />;
  }
  const re = pattern ? safeSearchRegex(pattern) : null;
  // Highlight the matched term inside the CONTENT only — never the `path:line:`
  // prefix (a highlight there would imply the match was in the path and would
  // fragment the path link). The prefix keeps full path linkification.
  const renderRow = (line: string): ReactNode => {
    if (!re) return linkifyPaths(line);
    const split = splitGrepRow(line);
    const prefix = split?.prefix ?? "";
    const content = split ? split.content : line;
    return (
      <>
        {prefix && <span>{linkifyPaths(prefix)}</span>}
        {splitMatches(content, re).map((seg, i) =>
          seg.match ? (
            <mark key={i} className="rounded-sm bg-amber-400/25 px-0.5 text-amber-100">
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{linkifyPaths(seg.text)}</span>
          )
        )}
      </>
    );
  };
  return (
    <div className="max-h-56 overflow-y-auto rounded-md bg-background/60 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
      {lines.map((line, i) => (
        <div
          key={i}
          className="whitespace-pre-wrap break-all border-b border-border/10 px-2 py-1 last:border-0"
        >
          {renderRow(line)}
        </div>
      ))}
    </div>
  );
}

/** A parsed WebSearch result: display title + destination URL. */
type WebResult = { title: string; url: string };

/**
 * Tolerant parser for WebSearch output. The raw text is semi-structured, so we
 * try a few shapes in priority order — JSON `{title,url}` objects, markdown
 * links, then a line-scan that pairs a bare URL with nearby title text —
 * de-duplicating by URL. Garbage input yields `[]` and never throws.
 */
export function parseWebSearchResults(output: string): WebResult[] {
  const results: WebResult[] = [];
  const seen = new Set<string>();
  const push = (title: string, url: string) => {
    // Trim trailing sentence punctuation, but keep brackets that are balanced
    // inside the URL itself — e.g. `…/Function_(mathematics)` must keep its `)`.
    let u = url.trim().replace(/[.,;:'"]+$/, "");
    while (
      (u.endsWith(")") && !u.includes("(")) ||
      (u.endsWith("]") && !u.includes("["))
    ) {
      u = u.slice(0, -1).replace(/[.,;:'"]+$/, "");
    }
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    const t = title.trim().replace(/^[-*\d.)\s]+/, "").trim();
    results.push({ title: t || u, url: u });
  };

  // 1. JSON objects carrying "title"/"url" keys
  for (const m of output.matchAll(/\{[^{}]*\}/g)) {
    const url = m[0].match(/"url"\s*:\s*"([^"]+)"/)?.[1];
    if (!url) continue;
    push(m[0].match(/"title"\s*:\s*"([^"]*)"/)?.[1] ?? "", url);
  }
  if (results.length) return results;

  // 2. Markdown links [title](url)
  for (const m of output.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    push(m[1], m[2]);
  }
  if (results.length) return results;

  // 3. Line scan: a URL uses the leading text on its line, else the line above.
  // Capture greedily to whitespace (so balanced parens like `/Foo_(bar)` survive)
  // and let `push` trim any unbalanced trailing bracket / sentence punctuation.
  const urlRe = /(https?:\/\/\S+)/;
  let lastText = "";
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const um = line.match(urlRe);
    if (um) {
      push(line.slice(0, um.index).trim() || lastText, um[1]);
      lastText = "";
    } else if (line) {
      lastText = line;
    }
  }
  return results;
}

/** Structured WebSearch results: title links with a dimmed host beneath. */
function WebSearchResultsView({ output }: { output: string }) {
  const results = parseWebSearchResults(output);
  if (results.length === 0) return <ClampedPre text={output} />;
  return (
    <div className="space-y-1.5 rounded-md bg-background/60 p-2 text-[11px]">
      {results.map((r, i) => {
        let host = r.url;
        try {
          host = new URL(r.url).host;
        } catch {
          // keep the raw URL as the host label
        }
        return (
          <div key={i} className="min-w-0">
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-primary hover:underline"
            >
              {r.title}
            </a>
            <span className="block truncate text-[10px] text-muted-foreground/60">{host}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Read output is rarely worth showing — collapse to a stub by default. */
function ReadOutputStub({ output }: { output: string }) {
  const [open, setOpen] = useState(false);
  const lines = countLines(output.trimEnd());
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        {lines} lines read
      </button>
      {open && (
        <div className="mt-1">
          <ClampedPre text={output} />
        </div>
      )}
    </div>
  );
}
