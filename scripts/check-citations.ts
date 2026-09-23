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
//   (`enforcementHook`, `packages/ui-backend-claude/src/permission-hooks.ts:102-117`)
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
 * Anything inside a span that looks like it names a line — `name:12` at a word
 * boundary — so a shape the check cannot read is reported rather than
 * skipped. `localhost:6006/mcp` and `width:100%` are not followed by a
 * boundary and do not match.
 */
const LOOSE_CITATION = /(?:^|[\s(\[])[\w@./-]*[A-Za-z][\w@./-]*:\d+(?:-\d+)?(?=$|[\s,;.)\]])/;

/** A citation anywhere in prose, outside a code span. */
const BARE_CITATION = new RegExp(`(?<![\\w\`/.-])(${FILE}):\\d+`, "g");

/** A markdown link to a line, which cannot carry an anchor either. */
const LINE_LINK = /\]\(([^)\s]+)#L\d+/g;

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
}

export type Verdict =
  | { kind: "anchored"; file: string }
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
  let lastPath: string | undefined;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const content = span[1].replace(/\s+/g, " ").trim();
    const match = content.match(CITATION);
    if (!match) {
      // Something that cites a line but is not a shape this check reads —
      // `[brain-ui] scripts/entrypoint.sh:59-85`, a path with a space — is
      // reported, not skipped.
      if (LOOSE_CITATION.test(content)) {
        citations.push({
          doc,
          line: lineAt(span.index!),
          text: content,
          path: undefined,
          ranges: [],
          anchor: undefined,
          unreadable: true,
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
      const candidate = previous[1].replace(/\s+/g, " ").trim();
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
  if (citation.unreadable) {
    return { kind: "unresolved", reason: "not a `path:line` this check can read (another repository?)" };
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
 * says so. Two identical citations in one record share an entry, so they
 * share its reason.
 */
export const CITATION_EXCEPTIONS: Record<string, string> = {
  // Another repository. The `[brain-ui]` prefix says so; this check reads only
  // this tree.
  ...Object.fromEntries(
    [
      "docker-compose.yml:32-41",
      "docker-compose.yml:36",
      "docs/examples/docker-compose.coolify.yml:40-45",
      "scripts/brain-dispatch.sh:17-38",
      "scripts/entrypoint.sh:109-110",
      "scripts/entrypoint.sh:112-128",
      "scripts/entrypoint.sh:147-187",
      "scripts/entrypoint.sh:194-210",
      "scripts/entrypoint.sh:212-232",
      "scripts/entrypoint.sh:234-235",
      "scripts/entrypoint.sh:47-55",
      "scripts/entrypoint.sh:59-85",
      "Dockerfile:217-231",
      "Dockerfile:239-244",
      "Dockerfile:246-258",
      "Dockerfile:269-287",
      "config/supervisord.conf:43-58",
    ].map((cited) => [
      `docs/decisions/container-privilege.md|[brain-ui] ${cited}`,
      "cites the private deployment repository, which is not in this tree",
    ]),
  ),
  "docs/decisions/hardening.md|cron-run.ts:218":
    "cites the private deployment repository's cron runner, which is not in this tree",

  // A dependency's installed source, at the version the record measured.
  "docs/decisions/container-privilege.md|sdk.d.ts:2259-2278":
    "the Claude Agent SDK's installed sdk.d.ts, not in this tree",
  "docs/decisions/container-privilege.md|sdk.d.ts:8441-8474":
    "the Claude Agent SDK's installed sdk.d.ts, not in this tree",
  "docs/decisions/container-privilege.md|settings-manager.js:169":
    "pi 0.84.4's installed settings-manager.js, not in this tree",
  "docs/decisions/container-privilege.md|package-manager.js:1988-1993":
    "pi 0.84.4's installed package-manager.js, not in this tree",
  "docs/decisions/container-privilege.md|loader.js:473-482":
    "pi 0.84.4's installed extensions/loader.js, not in this tree",
  "docs/decisions/container-privilege.md|loader.js:320-323":
    "pi 0.84.4's installed extensions/loader.js, not in this tree",
  "docs/decisions/container-privilege.md|core/exec.js:10-16":
    "pi 0.84.4's installed core/exec.js, not in this tree",
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

  // A quotation. The words are another document's and are not reworded here.
  "docs/decisions/voice-permission.md|backend.ts:703-709":
    "inside a verbatim quote from docs/plans/async-collaboration.md; the file it meant is now too short to have these lines",

  // The code the record describes as it stood before the change the record
  // decided. That code is gone or now does the opposite, so there is nothing
  // current to anchor to, and re-pointing would make the record claim
  // something about code it never described.
  "docs/decisions/container-privilege.md|subprocess-env.ts:119-135":
    "describes the 0.32 denylist filter; filterSubprocessEnv is now an allowlist",
  "docs/decisions/design-kit.md|chat-page.tsx:142,158,168":
    "the static getState call sites this audit found were since fixed",
  "docs/decisions/design-kit.md|composer.tsx:205":
    "the static store access this audit found was since fixed",
  "docs/decisions/design-kit.md|pi-accounts.tsx:71":
    "the static store access this audit found was since fixed",
  "docs/decisions/design-kit.md|span-bits.tsx:88":
    "the default-store static this audit found was since fixed",
  "docs/decisions/design-kit.md|activity-store.ts:261,270":
    "activity-store.ts is now a re-export shim; the cited logic moved and no longer touches a default store",
  "docs/decisions/design-kit.md|chat-store.ts:364":
    "chat-store.ts is now a shim; the cited localStorage read moved behind an injected env.storage()",
  "docs/decisions/design-kit.md|provider-store.ts:44":
    "provider-store.ts is now a shim; the cited read moved behind an injected env.storage()",
  "docs/decisions/design-kit.md|file-store.ts:135":
    "file-store.ts is now a shim; the cited read moved behind an injected env.storage()",
  "docs/decisions/design-kit.md|components/chat/renderers/index.ts:10":
    "the module-level registration latch this audit found was since removed",
  "docs/decisions/design-kit.md|packages/ui-backend-claude/src/ask-user-tool.ts:104":
    "records the call as it was before D44; it now passes alwaysLoad",
  "docs/decisions/hardening.md|backend.ts:1039":
    "describes getBackendForSession substituting the default, which the fix replaced with a throw",
  "docs/decisions/session-principals.md|middleware/auth.ts:253":
    "the epoch-bearing cookie mint, replaced by principal cookies",
  "docs/decisions/session-principals.md|auth.ts:265-296":
    "epoch cookie verification, replaced by resolveCookiePrincipal",
  "docs/decisions/session-principals.md|auth.ts:321": "bumpSessionsEpoch, which was removed",
  "docs/decisions/session-principals.md|auth.ts:302-318":
    "the global sessionsEpoch settings row, which was removed",
  "docs/decisions/session-principals.md|auth.ts:321-330":
    "the global epoch revoke, replaced by per-principal revocation",
  "docs/decisions/session-principals.md|auth.ts:221-237":
    "isWsAuthorized returning a boolean; it now returns a principal",
  "docs/decisions/session-principals.md|app.ts:267-281":
    "the request log without an actor; it now logs the principal",
  "docs/decisions/session-principals.md|ws/connection.ts:251-253":
    "the upgrade ignoring the request context; it now reads the principal",
  "docs/decisions/session-principals.md|ws/connection.ts:74":
    "clients.add without an identity; it now carries the principal",
  "docs/decisions/session-principals.md|ws/connection.ts:162":
    "onMessage dispatching without a re-check; it now re-checks authorization",
  "docs/decisions/session-principals.md|ws/run-session.ts:133-141":
    "the recorder built without an actor; it now receives the principal",
  "docs/decisions/session-principals.md|ws/turns.ts:53-75":
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
  exceptions: Record<string, string> = CITATION_EXCEPTIONS,
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
      const verdict = checkCitation(citation, cited, tree);
      const exception = exceptions[`${doc}|${citation.text}`];
      reports.push({ citation, verdict, exception });
    }
  }
  return reports;
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
    case "unanchored":
    case "unresolved":
      return `${where} ${verdict.kind}: ${verdict.reason}`;
  }
}

if (import.meta.main) {
  const reports = checkRecords();
  const counts: Record<string, number> = {};
  for (const report of reports) {
    const key = report.exception ? "exception" : report.verdict.kind;
    counts[key] = (counts[key] ?? 0) + 1;
    if (report.verdict.kind !== "anchored" && !report.exception) console.log(describe(report));
  }
  console.log(`\n${reports.length} citation(s):`, counts);
}
