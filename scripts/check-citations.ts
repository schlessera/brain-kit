// Anchored `file:line` citations in the decision records.
//
//   bun scripts/check-citations.ts          # report every citation's state
//
// A decision record cites code as `path:line`, and a line number goes stale
// silently: after a PR inserts lines above it, the pointer names the
// neighbouring code and a reader who follows it is told something confidently
// wrong. The convention (`docs/decisions/README.md`) is to name the symbol and
// let the range follow it:
//
//   (`enforcementHook`, `packages/ui-backend-claude/src/permission-hooks.ts:106-129`)
//
// The anchor is the code span immediately before the citation, joined to it by
// a comma. Each cited range must START on a line containing the anchor, so an
// insertion anywhere above the symbol moves the range off it and this check
// goes red, and whoever fixes it can search for the anchor instead of redoing
// the arithmetic that caused the drift.
//
// What it cannot see is said here rather than skipped: a citation whose file it
// cannot resolve, or that names no anchor, is a failure unless it is listed in
// `CITATION_EXCEPTIONS` with its reason. The END of a range is not checked — a
// range that grows or shrinks around its first line still passes.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

export const ROOT = resolve(import.meta.dir, "..");

/**
 * A file name a citation can use: anything with an extension, or one of the
 * conventional extensionless build files.
 */
const FILE = "(?:[\\w@.-]+/)*(?:[\\w@-][\\w@.-]*\\.[A-Za-z][A-Za-z0-9]*|[A-Z][A-Za-z]*file)";

/** `path:12`, `path:12-40`, `path:12,40-44`, or `:12` continuing the last path. */
const CITATION = new RegExp(`^(${FILE})?:(\\d+(?:-\\d+)?(?:,\\s*\\d+(?:-\\d+)?)*)$`);

/**
 * Anything inside a span that names a line of a file in ANY spelling the
 * strict pattern does not read — `[brain-ui] Dockerfile:12`, `a.ts:12:3`,
 * `a.ts: 12`, `a.ts:2–4`, `"a.ts:2"`, a URL with `#L12` — so it is reported
 * rather than skipped. Matched as "contains", not by shape: a file name (a
 * dot extension, a path, or a `*file`) then a colon and a digit, or `#L` and a
 * digit. CSS such as `flex:1 1 auto` has no file name before its colon.
 */
const LOOSE_CITATION =
  /(?:[\w-]?\.[A-Za-z]\w*|\/[\w.-]+|[A-Z][A-Za-z]*file|\b[A-Z][A-Z0-9_-]{2,})\s*:\s*\d|#L\d/;

/**
 * `[repo] path:12` — a citation into another repository. Only the public
 * repositories of the open-source project may be cited that way (#303); a
 * public record never cites the maintainer's private instance (AGENTS.md,
 * "The five repositories"). Read loosely, so a respelling (`[[brain]]`,
 * `[Schlessera/Brain-UI]`, a path with a space, a URL) is judged rather than
 * slipping through as some other kind of span.
 */
const EXTERNAL_CITATION = /^\[+([^\]]*)\]+\s*\(?\s*(\S.*?(?::\s*\d|#L\d).*?)\)?$/;

/** A path inside the named repository, and its lines: `scripts/a b.sh:4-9`. */
const EXTERNAL_PATH = /^([^:]+?):(\d+(?:\s*[-,]\s*\d+)*)$/;

/** The repositories a `[repo] path:line` citation may name. */
export const CITABLE_REPOS = new Set(["brain-template", "brain-hosting-template"]);

/**
 * The repository a bracket names, or undefined when it names none of the
 * project's: `[Schlessera/Brain-UI]`, `[ brain-ui ]` and
 * `[https://github.com/schlessera/brain-ui.git/]` are one repository, while
 * `[data-x]` and `[server]` are CSS and log text, not a repository.
 */
export function repoIdentity(prefix: string): string | undefined {
  const id = prefix
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/|git@)?(?:www\.)?(?:github\.com[/:])?(?:schlessera\/)?/, "")
    .replace(/(?:\.git)?\/*$/, "");
  return /^brain(?:-[a-z0-9-]+)?$/.test(id) ? id : undefined;
}

/** A citation anywhere in prose, outside a code span. */
const BARE_CITATION = new RegExp(
  `(?<![\\w\`/.-])(${FILE}|[\\w@.-]+/[\\w@./-]*[\\w@-]|[A-Z][A-Z0-9_-]+|\\.[\\w.-]+)[ \\t]*:[ \\t]*\\n?[ \\t]*\\d+`,
  "g",
);

/**
 * A `#L12` line fragment anywhere in prose — an inline or reference link, an
 * HTML `href` in any spelling, an autolink, a bare path — which cannot carry
 * an anchor either.
 */
const LINE_LINK = /([^\s"'<>()[\]`]+)#L\d+/gi;

export interface Citation {
  /** The record, repo-relative. */
  doc: string;
  /** 1-based line in the record where the citation span starts. */
  line: number;
  /** The citation as written, without backticks. */
  text: string;
  /** The path as written, or the path it continues for a bare `:12`. */
  path: string | undefined;
  ranges: { start: number; end: number }[];
  /** The code span immediately before it, joined by a comma. */
  anchor: string | undefined;
  /** Written outside a code span, so it cannot carry an anchor. */
  bare?: boolean;
  /** A span that cites a line in a shape this check cannot read. */
  unreadable?: boolean;
  /** For an extensionless `name:12`: the name, which must be a file to count. */
  fileName?: string;
  /** For `[repo] path:12`: the other repository it cites. */
  repo?: string;
}

export type Verdict =
  | { kind: "anchored"; file: string }
  /** Cites a public repository of the project: accepted, not verifiable here. */
  | { kind: "external"; repo: string }
  /** Cites a private repository: never accepted, whatever an exception says. */
  | { kind: "private"; repo: string; reason: string }
  | { kind: "drifted"; file: string; range: string; found: number[] }
  | { kind: "unanchored"; reason: string }
  | { kind: "unresolved"; reason: string };

/** Fenced blocks blanked to empty lines, so line numbers survive. */
function withoutFences(body: string): string {
  const lines = body.split("\n");
  let fence: string | undefined;
  return lines
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return "";
      }
      if (marker) {
        fence = marker;
        return "";
      }
      return line;
    })
    .join("\n");
}

/** Every citation in one record, in order. */
export function parseCitations(doc: string, body: string): Citation[] {
  const text = withoutFences(body);
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  const citations: Citation[] = [];
  // Code spans, with what separates each from the one before it.
  // A span may wrap onto the next line, as markdown allows, but not across a
  // blank one.
  const spans = [...text.matchAll(/`((?:[^`\n]|\n(?![ \t]*\n))+)`/g)];
  // Every span's text normalised once, the same way for the span and for its
  // neighbours. A wrap right after the colon (`hooks.ts:` then `12`) is still
  // one citation.
  const contents = spans.map((span) =>
    span[1].replace(/:[ \t]*\n\s*(?=\d)/g, ":").replace(/\s+/g, " ").trim(),
  );
  /** Whether a span is a citation, or a line number continuing one. */
  const citationish: boolean[] = [];
  let lastPath: string | undefined;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const content = contents[i];
    const match = content.match(CITATION);
    // A line number right after a citation, joined by `/` or a comma
    // (`chat-store.ts:364`/`228`, and any chain of them), is another line of
    // that file in a shape the check cannot anchor. So is a `:12:3` with a
    // column. Both are reported, not skipped.
    const before = spans[i - 1];
    const continuesCitation =
      /^:?\d+(?:\s*[-,:\u2013\u2014]\s*\d+)*$/.test(content) &&
      before !== undefined &&
      citationish[i - 1] &&
      /^\s*\)?\s*(?:\/|,|and)\s*$/.test(text.slice(before.index! + before[0].length, span.index));
    // Any other span that starts with a colon and a line number: `:4:2`,
    // `: 20`, `:20–24`.
    const lineWithColumn = !match && /^:\s*\d/.test(content);
    citationish[i] =
      Boolean(match) || continuesCitation || lineWithColumn || LOOSE_CITATION.test(content);
    const external = content.match(EXTERNAL_CITATION);
    const repo = external ? repoIdentity(external[1]) : undefined;
    if (external && repo !== undefined) {
      citationish[i] = true;
      const target = external[2].trim().match(EXTERNAL_PATH);
      citations.push({
        doc,
        line: lineAt(span.index!),
        text: content,
        path: target?.[1],
        ranges: [],
        anchor: undefined,
        repo,
      });
      continue;
    }
    if (!match && (continuesCitation || lineWithColumn)) {
      citations.push({
        doc,
        line: lineAt(span.index!),
        text: content,
        path: undefined,
        ranges: [],
        anchor: undefined,
        unreadable: true,
      });
      continue;
    }
    if (!match) {
      // Something that cites a line but is not a shape this check reads —
      // `[brain-ui] scripts/entrypoint.sh:59-85`, a path with a space — is
      // reported, not skipped.
      // A lowercase extensionless name (`post-commit:12`) cannot be told
      // from CSS (`flex-shrink:0`) by shape, so it is kept as a candidate and
      // reported only if a file in the tree has that name.
      const bareName = content.match(/^([\w@-]+)\s*:\s*\d+(?:\s*[-,\u2013]\s*\d+)*$/)?.[1];
      // A URL's host and port are not a file and a line.
      const withoutHosts = content.replace(/[a-z][\w+.-]*:\/\/[^/\s#?]*/gi, "//host");
      const loose = LOOSE_CITATION.test(withoutHosts);
      if (loose || bareName) {
        citations.push({
          doc,
          line: lineAt(span.index!),
          text: content,
          path: undefined,
          ranges: [],
          anchor: undefined,
          unreadable: true,
          ...(loose ? {} : { fileName: bareName }),
        });
      }
      continue;
    }
    const path = match[1] ?? lastPath;
    if (match[1]) lastPath = match[1];
    const ranges = match[2].split(",").map((part) => {
      const [start, end] = part.trim().split("-").map(Number);
      return { start, end: end ?? start };
    });
    let anchor: string | undefined;
    const previous = spans[i - 1];
    if (previous) {
      const between = text.slice(previous.index! + previous[0].length, span.index);
      const candidate = contents[i - 1];
      if (/^,\s*$/.test(between) && !CITATION.test(candidate)) anchor = candidate;
    }
    citations.push({
      doc,
      line: lineAt(span.index!),
      text: span[1].replace(/\s+/g, " ").trim(),
      path,
      ranges,
      anchor,
    });
  }
  // Citations written in prose, outside any code span.
  const prose = text.replace(/`((?:[^`\n]|\n(?![ \t]*\n))+)`/g, (span) =>
    span.replace(/[^\n]/g, " "),
  );
  for (const match of [...prose.matchAll(BARE_CITATION), ...prose.matchAll(LINE_LINK)]) {
    citations.push({
      doc,
      line: lineAt(match.index!),
      text: match[0],
      path: match[1],
      ranges: [],
      anchor: undefined,
      bare: true,
    });
  }
  return citations.sort((a, b) => a.line - b.line);
}

/** The files a citation can resolve into, and their lines. */
export interface Tree {
  files: string[];
  lines(file: string): string[];
}

let workingTree: Tree | undefined;

/** This checkout, read once. */
export function repoTree(): Tree {
  if (workingTree) return workingTree;
  const cache = new Map<string, string[]>();
  workingTree = {
    files: walkRepo(),
    lines(file) {
      if (!cache.has(file)) cache.set(file, readFileSync(join(ROOT, file), "utf8").split("\n"));
      return cache.get(file)!;
    },
  };
  return workingTree;
}

/**
 * The files git would show: tracked, plus new files not yet ignored. Build
 * output and `node_modules` are not citable and must not make a short path
 * ambiguous.
 */
function walkRepo(): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT },
  );
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  const files = result.stdout.toString().split("\0").filter(Boolean);
  // `--cached` still lists a file deleted in the working tree.
  return [...new Set(files)].filter((file) => existsSync(join(ROOT, file)));
}

/**
 * The repo file a cited path names.
 *
 * A full path resolves as written. A shortened one (`permission-hooks.ts`,
 * `ws/turns.ts`) resolves when exactly one file in the tree ends with it, or
 * when the record has already cited exactly one such file in full. Anything
 * else is unresolved — never a guess.
 */
export function resolveCitedPath(
  path: string,
  citedInDoc: string[],
  tree: Tree = repoTree(),
): { file: string } | { reason: string } {
  const files = tree.files;
  if (files.includes(path)) return { file: path };
  const suffix = (file: string) => file === path || file.endsWith(`/${path}`);
  const inDoc = [...new Set(citedInDoc.filter((cited) => files.includes(cited) && suffix(cited)))];
  if (inDoc.length === 1) return { file: inDoc[0] };
  const candidates = files.filter(suffix);
  if (candidates.length === 1) return { file: candidates[0] };
  if (candidates.length === 0) return { reason: `no file in the tree ends with ${path}` };
  return { reason: `${path} is ambiguous: ${candidates.slice(0, 4).join(", ")}` };
}

/** An anchor has to be able to tell one line from another. */
export function anchorTooWeak(anchor: string): boolean {
  return anchor.trim().length < 4 || !/[A-Za-z0-9]/.test(anchor);
}

/** Whether a citation still points at its anchor. */
export function checkCitation(
  citation: Citation,
  citedInDoc: string[],
  tree: Tree = repoTree(),
): Verdict {
  if (citation.bare) return { kind: "unanchored", reason: "written outside a code span" };
  if (citation.repo !== undefined) {
    if (citation.repo === "brain-kit") {
      return { kind: "unresolved", reason: "names this repository; cite the path without a prefix" };
    }
    if (!CITABLE_REPOS.has(citation.repo)) {
      return {
        kind: "private",
        repo: citation.repo,
        reason: `cites ${citation.repo}, which is not a public repository of the project; a public record never cites one`,
      };
    }
    // Only a path inside the named repository is that repository's: a URL or
    // a `../` could point anywhere, whatever the prefix says.
    const path = citation.path;
    if (!path || /:\/\/|^\/|(?:^|\/)\.\.(?:\/|$)/.test(path)) {
      return { kind: "unresolved", reason: `not a \`path:line\` inside ${citation.repo}` };
    }
    return { kind: "external", repo: citation.repo };
  }
  if (citation.unreadable) {
    return { kind: "unresolved", reason: "not a `path:line` this check can read: another repository, or a bare line number" };
  }
  if (!citation.path) return { kind: "unresolved", reason: "a bare line number with no file before it" };
  const resolved = resolveCitedPath(citation.path, citedInDoc, tree);
  if ("reason" in resolved) return { kind: "unresolved", reason: resolved.reason };
  if (!citation.anchor) return { kind: "unanchored", reason: "no anchor span before it" };
  if (anchorTooWeak(citation.anchor)) {
    return { kind: "unanchored", reason: `anchor \`${citation.anchor}\` is too short to locate` };
  }
  const lines = tree.lines(resolved.file);
  for (const { start, end } of citation.ranges) {
    if (!lines[start - 1]?.includes(citation.anchor)) {
      const found = lines.flatMap((line, i) => (line.includes(citation.anchor!) ? [i + 1] : []));
      return {
        kind: "drifted",
        file: resolved.file,
        range: start === end ? `${start}` : `${start}-${end}`,
        found,
      };
    }
  }
  return { kind: "anchored", file: resolved.file };
}

/**
 * Citations that cannot carry a checkable anchor, each with the reason.
 *
 * Keyed `<record>|<citation as written>`. An entry here is a claim about one
 * citation; if the citation changes, the entry stops matching and the check
 * says so. An entry covers exactly as many identical citations as it
 * declares, so a new one cannot borrow an old one's reason.
 */
/**
 * An exception's reason, or its reason and how many citations it covers.
 * A bare reason covers exactly one: a second identical citation in the same
 * record is a new pointer, and it must not inherit the first one's excuse.
 */
export type CitationException = string | { reason: string; occurrences: number };

export const CITATION_EXCEPTIONS: Record<string, CitationException> = {
  // A dependency's installed source, at the version the record measured.
  ...Object.fromEntries(
    [
      "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1887-1889",
      "sdk.d.ts:5590",
      "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:228",
      "sdk.mjs:127",
      "node_modules/@anthropic-ai/claude-agent-sdk/package.json:6-29",
      "sdk.d.ts:5585",
      "sdk.d.ts:3484",
      "sdk.d.ts:23",
    ].map((cited) => [
      `docs/decisions/claude-code-runtime.md|${cited}`,
      "the Claude Agent SDK's installed package, not in this tree",
    ]),
  ),
  "docs/decisions/session-principals.md|hono/utils/cookie.js:79-89":
    "hono's installed cookie utility, not in this tree",

  // Exact historical permalinks, not live-tree citations. parseCitations reads
  // their line fragments too; each URL was verified against its pinned source.
  // A changed SHA, path or first line needs its own verified exception.
  ...Object.fromEntries(
    [
      "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/fe5c75162882cd1f67af2cb808de37094ebea38d/packages/ui-backend-pi/src/brain-access.ts#L280",
      "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/core/src/lib/module-types.ts#L12",
      "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/module-jobs/src/pipeline.ts#L151",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/middleware/auth.ts#L253",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/app.ts#L267",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/middleware/auth.ts#L221",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/ws/connection.ts#L74",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/ws/run-session.ts#L133",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/ws/turns.ts#L53",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/middleware/passkeys.ts#L578",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/activity/stream.ts#L153",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/activity/stream.ts#L326",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/ws/connection.ts#L162",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/cron/run-job.ts#L108",
      "docs/decisions/session-principals.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/index.ts#L44",
      "docs/decisions/design-kit/foundations.md|https://github.com/schlessera/brain-kit/blob/7a7bd9caff1453abaceddc98826b652f2ca955cb/packages/module-jobs/src/types.ts#L147",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/chat/chat-page.tsx#L142",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/chat/composer.tsx#L205",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/settings/pi-accounts.tsx#L71",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/activity/span-bits.tsx#L88",
      "docs/decisions/audit-repair-suggestions.md|https://github.com/schlessera/brain-kit/blob/7e398dc207f2c4725f6c364331c3cd5d3112954d/packages/core/src/cli/commands/audit.ts#L26",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/stores/activity-store.ts#L261",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/stores/chat-store.ts#L228",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/stores/provider-store.ts#L8",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/stores/file-store.ts#L26",
      "docs/decisions/design-kit/state-architecture.md|https://github.com/schlessera/brain-kit/blob/5835058d4eeee18aae483b180234e9c861ba9c7b/packages/ui-react/src/components/chat/renderers/index.ts#L10",
      // D52's "today" key map, before #946 moved the destinations into desktop-routes.ts.
      "docs/decisions/design-kit/sessions-and-drafts.md|https://github.com/schlessera/brain-kit/blob/18d5ddee154b5dbebb3dbd6c487bc8ea1fc036db/packages/ui-react/src/components/layout/desktop-palette.tsx#L84",
      "docs/decisions/design-kit/show-block-brief.md|https://github.com/schlessera/brain-kit/blob/70e7ed3808c81a6aa5d59ea316dec9888851c155/packages/ui-backend-claude/src/ask-user-tool.ts#L104",
      "docs/decisions/design-kit/show-block-brief.md|https://github.com/schlessera/brain-kit/blob/2efd725e233abefca36c25693cd362cf69a0b1bd/docs/decisions/design-kit.md#L2522",
      "docs/decisions/hardening.md|https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/middleware/auth.ts#L253",
      "docs/decisions/hardening.md|https://github.com/schlessera/brain-kit/blob/b44fd7d356cf414de54bbb59c63fc966b10cca8b/packages/ui-server/src/agent/backend.ts#L1039",
      "docs/decisions/claude-code-runtime.md|https://github.com/schlessera/brain-kit/blob/af2affb2e939cc39446abeaccc704b617d9e6fd7/scripts/measure-show-block.ts#L304",
      "docs/decisions/claude-code-runtime.md|https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/ui-backend-claude/src/sdk-options.ts#L85",
      "docs/decisions/claude-code-runtime.md|https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/ui-backend-claude/src/module.ts#L226",
      "docs/decisions/claude-code-runtime.md|https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/ui-backend-claude/src/model-discovery.ts#L86",
      "docs/decisions/claude-code-runtime.md|https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/core/src/providers/agents/cli-runners.ts#L37",
      "docs/decisions/claude-code-runtime.md|https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/core/src/lib/config.ts#L166",
      "docs/decisions/claude-code-runtime.md|https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/core/src/lib/registry.ts#L40",
      // The UI-server readers and manifest before #697 moved them onto core's queries.
      "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/src/graph/reader.ts#L437",
      "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/src/graph/reader.ts#L525",
      "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/src/voice/keyterm-builder.ts#L390",
      "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/package.json#L56",
      "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/package.json#L70",
    ].map((cited) => [
      cited,
      "verified commit-pinned historical evidence; the adjacent dated note scopes the old implementation and links its replacement",
    ]),
  ),

  // The code the record describes as it stood before the change the record
  // decided. That code is gone or now does the opposite, so there is nothing
  // current to anchor to, and re-pointing would make the record claim
  // something about code it never described.
  "docs/decisions/design-kit/state-architecture.md|chat-page.tsx:142,158,168":
    "the static getState call sites this audit found were since fixed",
  "docs/decisions/design-kit/state-architecture.md|composer.tsx:205":
    "the static store access this audit found was since fixed",
  "docs/decisions/design-kit/state-architecture.md|pi-accounts.tsx:71":
    "the static store access this audit found was since fixed",
  "docs/decisions/design-kit/state-architecture.md|span-bits.tsx:88":
    "the default-store static this audit found was since fixed",
  "docs/decisions/design-kit/state-architecture.md|activity-store.ts:261,270":
    "activity-store.ts is now a re-export shim; the cited logic moved and no longer touches a default store",
  "docs/decisions/design-kit/state-architecture.md|chat-store.ts:364":
    "chat-store.ts is now a shim; the cited localStorage read moved behind an injected env.storage()",
  "docs/decisions/design-kit/state-architecture.md|provider-store.ts:44":
    "provider-store.ts is now a shim; the cited read moved behind an injected env.storage()",
  "docs/decisions/design-kit/state-architecture.md|228":
    "the guard line paired with chat-store.ts:364; chat-store.ts is now a shim",
  "docs/decisions/design-kit/state-architecture.md|8":
    "the guard line paired with provider-store.ts:44; provider-store.ts is now a shim",
  "docs/decisions/design-kit/state-architecture.md|26":
    "the guard line paired with file-store.ts:135; file-store.ts is now a shim",
  "docs/decisions/design-kit/state-architecture.md|file-store.ts:135":
    "file-store.ts is now a shim; the cited read moved behind an injected env.storage()",
  "docs/decisions/design-kit/state-architecture.md|components/chat/renderers/index.ts:10":
    "the module-level registration latch this audit found was since removed",
  "docs/decisions/design-kit/show-block-brief.md|packages/ui-backend-claude/src/ask-user-tool.ts:107":
    "records the call as it was before D44; it now passes alwaysLoad",
  "docs/decisions/claude-code-runtime.md|packages/ui-backend-claude/src/model-discovery.ts:86-104":
    "model discovery preferring the API key; #253 made it prefer the subscription token",
  "docs/decisions/claude-code-runtime.md|packages/core/src/providers/agents/cli-runners.ts:37-43":
    "the Claude runner spawning with the inherited environment; #253 moved it to a cleared, handshake-checked session",
  "docs/decisions/claude-code-runtime.md|cli-runners.ts:66-72":
    "the Claude streaming runner spawning with the inherited environment, replaced by #253",
  "docs/decisions/claude-code-runtime.md|scripts/measure-show-block.ts:304,369":
    "the harness as it stood before #209 gave it --both-arms and a recorded version",
  "docs/decisions/claude-code-runtime.md|packages/core/src/lib/registry.ts:40":
    "the completion registry building providers with no options; #253 added completions.apiKeyEnv",
  "docs/decisions/claude-code-runtime.md|packages/core/src/lib/config.ts:166-171":
    "the completions schema as it stood when this was written, with only provider and fallback; #253 added completions.apiKeyEnv",
  "docs/decisions/hardening.md|backend.ts:1039":
    "describes getBackendForSession substituting the default, which the fix replaced with a throw",
  "docs/decisions/index-query-api.md|https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/tests/allowed-edges.ts#L92": {
    reason: "verified commit-pinned historical evidence: the edge row before #697 added the core peer",
    occurrences: 2,
  },
  "docs/decisions/session-principals.md|middleware/auth.ts:253": {
    reason: "the epoch-bearing cookie mint, replaced by principal cookies",
    occurrences: 2,
  },
  "docs/decisions/session-principals.md|auth.ts:265-296": {
    reason: "epoch cookie verification, replaced by resolveCookiePrincipal",
    occurrences: 2,
  },
  "docs/decisions/session-principals.md|auth.ts:321": "bumpSessionsEpoch, which was removed",
  "docs/decisions/session-principals.md|auth.ts:302-318":
    "the global sessionsEpoch settings row, which was removed",
  "docs/decisions/session-principals.md|auth.ts:321-330":
    "the global epoch revoke, replaced by per-principal revocation",
  "docs/decisions/session-principals.md|auth.ts:221-237":
    "isWsAuthorized returning a boolean; it now returns a principal",
  "docs/decisions/session-principals.md|app.ts:268-282":
    "the request log without an actor; it now logs the principal",
  "docs/decisions/session-principals.md|ws/connection.ts:262-264":
    "the upgrade ignoring the request context; it now reads the principal",
  "docs/decisions/session-principals.md|ws/connection.ts:84":
    "clients.add without an identity; it now carries the principal",
  "docs/decisions/session-principals.md|ws/connection.ts:173":
    "onMessage dispatching without a re-check; it now re-checks authorization",
  "docs/decisions/session-principals.md|ws/run-session.ts:134-142":
    "the recorder built without an actor; it now receives the principal",
  "docs/decisions/session-principals.md|ws/turns.ts:55-77":
    "RunningTurn without an actor; it now carries principalId",
  "docs/decisions/session-principals.md|passkeys.ts:578-586":
    "passkey delete bumping the global epoch; it now revokes by credential",
  "docs/decisions/session-principals.md|activity/stream.ts:153":
    "the subscription registry keyed on the wrapper, since fixed",
  "docs/decisions/session-principals.md|stream.ts:326":
    "the subscribe-by-wrapper leak, since fixed",
  "docs/decisions/session-principals.md|stream.ts:354": "the drop-by-wrapper leak, since fixed",
  "docs/decisions/session-principals.md|cron/run-job.ts:113":
    "cron writing spans with no principal; it now sets one",
  "docs/decisions/session-principals.md|src/index.ts:44-45":
    "root exports of bumpSessionsEpoch, which was removed",
};

/** Every markdown file under `docs/decisions/`, at any depth. */
export function decisionRecords(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = `${dir}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (name.endsWith(".md")) found.push(path);
    }
  };
  walk("docs/decisions");
  return found.sort();
}

export interface Report {
  citation: Citation;
  verdict: Verdict;
  exception?: string;
}

/** Every citation in the given records, checked against the tree. */
export function checkRecords(
  records: { doc: string; body: string }[] = decisionRecords().map((doc) => ({
    doc,
    body: readFileSync(join(ROOT, doc), "utf8"),
  })),
  tree: Tree = repoTree(),
  exceptions: Record<string, CitationException> = CITATION_EXCEPTIONS,
): Report[] {
  const reports: Report[] = [];
  for (const { doc, body } of records) {
    const citations = parseCitations(doc, body);
    // Full paths the record names anywhere, citation or not, disambiguate the
    // shortened ones: a record that says `packages/ui-server/src/middleware/auth.ts`
    // once can say `auth.ts:321` after it.
    const named = [
      ...body.matchAll(/`((?:[\w@.-]+\/)+[\w@.-]+\.\w+)(?::[\d,\s-]+)?`/g),
    ].map((m) => m[1]);
    const cited = [...named, ...citations.flatMap((c) => (c.path && !c.bare ? [c.path] : []))];
    for (const citation of citations) {
      if (
        citation.fileName &&
        !tree.files.some((file) => file === citation.fileName || file.endsWith(`/${citation.fileName}`))
      ) {
        continue;
      }
      const verdict = checkCitation(citation, cited, tree);
      const entry = exceptions[`${doc}|${citation.text}`];
      const exception = typeof entry === "string" ? entry : entry?.reason;
      reports.push({ citation, verdict, exception });
    }
  }
  return reports;
}

/**
 * Exceptions whose count does not match the citations that need them: `0`
 * means the entry is stale, more than declared means a second identical
 * citation is borrowing an excuse written for the first.
 */
export function exceptionMismatches(
  reports: Report[],
  exceptions: Record<string, CitationException> = CITATION_EXCEPTIONS,
): { key: string; expected: number; actual: number }[] {
  const actual = new Map<string, number>();
  for (const report of reports) {
    // An exception never covers an external citation, which needs none, or a
    // private one, which none may excuse, so an entry for either is stale.
    const kind = report.verdict.kind;
    if (kind === "anchored" || kind === "external" || kind === "private" || !report.exception) continue;
    const key = `${report.citation.doc}|${report.citation.text}`;
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  return Object.entries(exceptions).flatMap(([key, entry]) => {
    const expected = typeof entry === "string" ? 1 : entry.occurrences;
    const found = actual.get(key) ?? 0;
    return found === expected ? [] : [{ key, expected, actual: found }];
  });
}

/**
 * Whether a report fails the check: anything not anchored or external that no
 * exception covers, and a citation of a private repository, always.
 */
export function failing(report: Report): boolean {
  if (report.verdict.kind === "private") return true;
  return report.verdict.kind !== "anchored" && report.verdict.kind !== "external" && !report.exception;
}

export function describe(report: Report): string {
  const { citation, verdict } = report;
  const where = `${citation.doc}:${citation.line} \`${citation.text}\``;
  switch (verdict.kind) {
    case "anchored":
      return `${where} anchored on \`${citation.anchor}\``;
    case "drifted":
      return (
        `${where} does not start on \`${citation.anchor}\` in ${verdict.file}:${verdict.range}` +
        (verdict.found.length ? ` — it is at line ${verdict.found.join(", ")}` : " — it is not in the file")
      );
    case "external":
      return `${where} cites ${verdict.repo}, not verifiable from this tree`;
    case "unanchored":
    case "unresolved":
    case "private":
      return `${where} ${verdict.kind}: ${verdict.reason}`;
  }
}

/** What the command prints: each failure, the counts, each stale exception. */
export function summarize(
  reports: Report[],
  exceptions: Record<string, CitationException> = CITATION_EXCEPTIONS,
): string[] {
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  for (const report of reports) {
    const kind = report.verdict.kind;
    const key = report.exception && kind !== "private" && kind !== "external" ? "exception" : kind;
    counts[key] = (counts[key] ?? 0) + 1;
    if (failing(report)) lines.push(describe(report));
  }
  lines.push(`\n${reports.length} citation(s): ${JSON.stringify(counts)}`);
  for (const { key, expected, actual } of exceptionMismatches(reports, exceptions)) {
    lines.push(`exception ${key} declares ${expected} citation(s), matches ${actual}`);
  }
  return lines;
}

if (import.meta.main) {
  for (const line of summarize(checkRecords())) console.log(line);
}
