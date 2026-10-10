import { Glob } from "bun";
import { parseFrontmatter, type ParsedFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "path";

import {
  extractWikiLinks,
  getAssetFiles,
  getMarkdownFiles,
  resolveAlias,
} from "./indexer.js";
import { normalizeFrontmatterDates, stringifyDocument } from "./frontmatter.js";
import { safeResolve, writeFileSafely } from "./safe-path.js";
import { assertScratchWritable, isInScratch, pruneScratch, writeScratchFile } from "./scratch.js";
import type { Taxonomy } from "./taxonomy.js";
import { createWikiLinkResolver } from "./indexer/links.js";

export interface OkfExportOptions {
  root: string;
  taxonomy: Taxonomy;
  /** Repo-relative output directory. Defaults to `okf-dist`. */
  outDir?: string;
  /** Repo-relative directory prefixes to include. */
  include?: string[];
  /** Repo-relative directory prefixes to exclude from the selected set. */
  exclude?: string[];
  /** Copy image/PDF assets in the selected scope. Defaults to true. */
  copyAssets?: boolean;
}

export interface OkfDegradedLink {
  file: string;
  link: string;
}

export interface OkfExportReport {
  outDir: string;
  filesExported: number;
  assetsCopied: number;
  linksConverted: number;
  linksDegraded: number;
  degradedLinks: OkfDegradedLink[];
  indexFilesGenerated: number;
  topLevelDirectories: string[];
  warnings: string[];
}

export interface OkfCheckIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface OkfCheckReport {
  directory: string;
  ok: boolean;
  filesChecked: number;
  errors: number;
  warnings: number;
  issues: OkfCheckIssue[];
}

export class OkfExportError extends Error {}

interface ParsedConcept {
  path: string;
  content: string;
  data: Record<string, any>;
  exportedData: Record<string, any>;
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function normalizeScopePrefix(value: string, label: string): string {
  const normalized = value.replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    isAbsolute(normalized) ||
    normalized.includes("\\") ||
    normalized.split("/").some((part) => part === ".." || part === "") ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new OkfExportError(`${label} must be a non-empty repo-relative directory path: ${value}`);
  }
  return normalized;
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function selectPath(path: string, includes: string[], excludes: string[]): boolean {
  const included = includes.length === 0 || includes.some((prefix) => matchesPrefix(path, prefix));
  return included && !excludes.some((prefix) => matchesPrefix(path, prefix));
}

const EXPORT_MARKER = ".brain-okf-export";
const EXPORT_MARKER_CONTENT = "brain-kit OKF export\n";
const PROTECTED_OUTPUT_SEGMENTS = new Set([
  ".git", ".agents", ".claude", ".brain-ui", "node_modules", "scripts", "workspaces", "logs",
]);

function assertDisposableOutput(absolute: string): void {
  if (!existsSync(absolute)) return;
  if (!lstatSync(absolute).isDirectory()) {
    throw new OkfExportError("Output destination must be a directory");
  }
  if (readdirSync(absolute).length === 0) return;
  const marker = resolve(absolute, EXPORT_MARKER);
  try {
    if (lstatSync(marker).isFile() && readFileSync(marker, "utf-8") === EXPORT_MARKER_CONTENT) return;
  } catch { /* Missing or unreadable ownership marker: preserve the destination. */ }
  throw new OkfExportError(
    "Refusing to replace a nonempty directory not owned by the OKF exporter. Choose an empty output directory."
  );
}

function outputLocation(root: string, requested: string, taxonomy: Taxonomy): {
  absolute: string;
  relative: string;
} {
  const rootCanonical = safeResolve(root, ".");
  const absolute = safeResolve(root, requested);
  if (!rootCanonical || !absolute) {
    throw new OkfExportError(`Output directory escapes the brain root or crosses an unsafe symlink: ${requested}`);
  }
  const lexical = resolve(rootCanonical, requested);
  if (absolute !== lexical) {
    throw new OkfExportError(`Output directory must not traverse a symlink: ${requested}`);
  }

  const rel = slash(relative(rootCanonical, absolute)).replace(/\/+$/, "");
  if (!rel || rel === "." || rel.startsWith("../")) {
    throw new OkfExportError("Refusing to use the brain root as the OKF output directory");
  }
  if (rel.split("/").some((segment) => PROTECTED_OUTPUT_SEGMENTS.has(segment.toLowerCase()))) {
    throw new OkfExportError(`Refusing to export into a protected directory: ${rel}`);
  }
  if (!taxonomy.isExcludedDirectory(rel)) {
    throw new OkfExportError(
      `Output directory must be excluded from indexing: ${rel}. Add it to brain.config exclude.dirs.`
    );
  }
  return { absolute, relative: rel };
}

/** Collect last-commit timestamps for all files in one git history walk. */
function gitTimestamps(root: string, files: string[]): Map<string, string> {
  const timestamps = new Map<string, string>();
  if (files.length === 0) return timestamps;

  const proc = Bun.spawnSync([
    "git",
    "-C",
    root,
    "-c",
    "core.quotePath=false",
    "log",
    "--format=@@OKF@@%cI",
    "--name-only",
    "--relative",
    "--",
    ...files,
  ]);
  if (proc.exitCode !== 0) return timestamps;

  const wanted = new Set(files);
  let timestamp = "";
  for (const line of new TextDecoder().decode(proc.stdout).split("\n")) {
    if (line.startsWith("@@OKF@@")) {
      timestamp = line.slice("@@OKF@@".length).trim();
      continue;
    }
    const path = line.trim();
    if (timestamp && wanted.has(path) && !timestamps.has(path)) {
      timestamps.set(path, timestamp);
    }
  }
  return timestamps;
}

function transformedFrontmatter(
  source: Record<string, any>,
  gitTimestamp?: string
): Record<string, any> {
  const data = normalizeFrontmatterDates(source);
  const out: Record<string, any> = {};

  if (Object.hasOwn(data, "type")) out.type = data.type;
  if (Object.hasOwn(data, "title")) out.title = data.title;

  const description = Object.hasOwn(data, "summary") ? data.summary : data.description;
  if (description !== undefined && description !== null && description !== "") {
    out.description = description;
  }

  if (Object.hasOwn(data, "resource")) {
    out.resource = data.resource;
  } else if (data.repo) {
    out.resource = `https://github.com/${String(data.repo).replace(/^\/+|\/+$/g, "")}`;
  }

  if (Object.hasOwn(data, "tags")) out.tags = data.tags;

  const fallbackDate = typeof data.updated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.updated)
    ? `${data.updated}T00:00:00Z`
    : undefined;
  const timestamp = gitTimestamp || fallbackDate;
  if (timestamp) out.timestamp = timestamp;

  const mapped = new Set(["type", "title", "summary", "description", "resource", "tags", "timestamp"]);
  for (const [key, value] of Object.entries(data)) {
    if (!mapped.has(key)) out[key] = value;
  }
  return out;
}

function replaceInlineCodeSafely(text: string, replaceProse: (value: string) => string): string {
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("`", cursor);
    if (start === -1) return out + replaceProse(text.slice(cursor));

    out += replaceProse(text.slice(cursor, start));
    let ticks = 1;
    while (text[start + ticks] === "`") ticks++;
    const marker = "`".repeat(ticks);
    const end = text.indexOf(marker, start + ticks);
    if (end === -1) return out + replaceProse(text.slice(start));

    out += text.slice(start, end + ticks);
    cursor = end + ticks;
  }
  return out;
}

/** Apply a replacement only outside fenced and inline code spans. */
function replaceMarkdownProse(text: string, replaceProse: (value: string) => string): string {
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  let out = "";

  for (const line of lines) {
    const withoutNewline = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (fence) {
      out += line;
      const close = withoutNewline.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }

    const open = withoutNewline.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1][0] as "`" | "~", length: open[1].length };
      out += line;
      continue;
    }
    out += replaceInlineCodeSafely(line, replaceProse);
  }
  return out;
}

function transformWikiLinks(
  body: string,
  sourcePath: string,
  resolveLink: ReturnType<typeof createWikiLinkResolver>,
  aliasMap: Map<string, string[]>,
  report: Pick<OkfExportReport, "linksConverted" | "linksDegraded" | "degradedLinks">
): string {
  // Reuse the indexer's extraction semantics as the authoritative set of prose links.
  const extracted = new Set(extractWikiLinks(body));
  return replaceMarkdownProse(body, (prose) =>
    prose.replace(/\[\[([^\]]+)\]\]/g, (whole, inner: string) => {
      const pipe = inner.indexOf("|");
      const rawTarget = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      if (!rawTarget || !extracted.has(rawTarget)) return whole;

      const hash = rawTarget.indexOf("#");
      const targetWithoutFragment = (hash === -1 ? rawTarget : rawTarget.slice(0, hash)).trim();
      const fragment = hash === -1 ? "" : rawTarget.slice(hash + 1).trim();
      const display = pipe === -1
        ? (targetWithoutFragment ? targetWithoutFragment.replace(/\/$/, "") : fragment)
        : inner.slice(pipe + 1).trim();
      const resolved =
        resolveLink(rawTarget, sourcePath) ??
        resolveAlias(rawTarget, aliasMap, sourcePath);

      if (!resolved) {
        report.linksDegraded++;
        report.degradedLinks.push({ file: sourcePath, link: rawTarget });
        return display;
      }

      report.linksConverted++;
      return `[${display}](/${resolved}${fragment ? `#${fragment}` : ""})`;
    })
  );
}

function parentDirectories(path: string): string[] {
  const dirs: string[] = [""];
  let current = dirname(path);
  while (current !== "." && current !== "") {
    dirs.push(slash(current));
    current = dirname(current);
  }
  return dirs;
}

function directoryDisplayName(dir: string): string {
  if (!dir) return "Knowledge Bundle";
  return basename(dir)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function oneLine(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}

function generateIndex(
  dir: string,
  concepts: ParsedConcept[],
  directories: Set<string>
): string {
  const directConcepts = concepts
    .filter((concept) => slash(dirname(concept.path)) === (dir || "."))
    .sort((a, b) => a.path.localeCompare(b.path));
  const directSubdirs = [...directories]
    .filter((candidate) => candidate && slash(dirname(candidate)) === (dir || "."))
    .sort();

  const lines = [`# ${directoryDisplayName(dir)}`, ""];
  for (const concept of directConcepts) {
    const title = oneLine(concept.exportedData.title ?? basename(concept.path, ".md"));
    const description = concept.exportedData.description;
    lines.push(`* [${title}](${basename(concept.path)})${description ? ` - ${oneLine(description)}` : ""}`);
  }

  if (directSubdirs.length > 0) {
    if (directConcepts.length > 0) lines.push("");
    lines.push("# Subdirectories", "");
    for (const subdir of directSubdirs) {
      const indexConcept = concepts.find((concept) => concept.path === `${subdir}/_index.md`);
      const description = indexConcept?.exportedData.description;
      lines.push(`* [${basename(subdir)}](${basename(subdir)}/)${description ? ` - ${oneLine(description)}` : ""}`);
    }
  }

  const body = lines.join("\n").trimEnd() + "\n";
  return dir ? body : `---\nokf_version: "0.1"\n---\n\n${body}`;
}

export async function exportOkfBundle(options: OkfExportOptions): Promise<OkfExportReport> {
  const root = resolve(options.root);
  const output = outputLocation(root, options.outDir ?? "okf-dist", options.taxonomy);
  const includes = (options.include ?? []).map((value) => normalizeScopePrefix(value, "include"));
  const excludes = (options.exclude ?? []).map((value) => normalizeScopePrefix(value, "exclude"));

  const markdownFiles = getMarkdownFiles(root, options.taxonomy)
    .filter((path) => selectPath(path, includes, excludes));
  for (const path of markdownFiles) {
    const name = basename(path);
    if (name === "index.md" || name === "log.md") {
      throw new OkfExportError(
        `Source concept uses reserved OKF filename "${name}": ${path}. Rename it before exporting.`
      );
    }
  }

  const gitTimes = gitTimestamps(root, markdownFiles);
  const concepts: ParsedConcept[] = [];
  const fileMap = new Map<string, string>();
  const aliasMap = new Map<string, string[]>();

  for (const path of markdownFiles) {
    const raw = readFileSync(resolve(root, path), "utf-8");
    let parsed: ParsedFrontmatter;
    try {
      parsed = parseFrontmatter(raw);
    } catch (error) {
      throw new OkfExportError(`Cannot parse frontmatter in ${path}: ${(error as Error).message}`);
    }
    const data = parsed.data as Record<string, any>;
    const exportedData = transformedFrontmatter(data, gitTimes.get(path));
    concepts.push({ path, content: parsed.content, data, exportedData });
    fileMap.set(path, String(data.title ?? basename(path, ".md")));
    if (Array.isArray(data.aliases)) {
      for (const value of data.aliases) {
        const alias = String(value).toLowerCase().trim();
        if (!alias) continue;
        const paths = aliasMap.get(alias) ?? [];
        paths.push(path);
        aliasMap.set(alias, paths);
      }
    }
  }

  const assetFiles = (options.copyAssets ?? true)
    ? getAssetFiles(root, options.taxonomy).filter((asset) => selectPath(asset.path, includes, excludes))
    : [];
  const report: OkfExportReport = {
    outDir: output.relative,
    filesExported: concepts.length,
    assetsCopied: assetFiles.length,
    linksConverted: 0,
    linksDegraded: 0,
    degradedLinks: [],
    indexFilesGenerated: 0,
    topLevelDirectories: [...new Set(
      [...markdownFiles, ...assetFiles.map((asset) => asset.path)]
        .filter((path) => path.includes("/"))
        .map((path) => path.split("/")[0])
    )].sort(),
    warnings: [],
  };

  // Exclusion from indexing is not permission to delete unrelated data.
  assertDisposableOutput(output.absolute);
  // The scratch area is excluded too, so it passes the check above; a bundle
  // written there is held to the scratch rules like any other write (#310).
  const scratchOutput = isInScratch(root, output.absolute);
  if (scratchOutput) {
    try {
      assertScratchWritable(root, output.absolute);
    } catch (error) {
      throw new OkfExportError(error instanceof Error ? error.message : String(error));
    }
  }
  // Into scratch, every file goes through the one write primitive, which
  // checks the target at the moment of the write.
  const put = (destination: string, content: string | Uint8Array, replace: boolean): void => {
    if (scratchOutput) {
      writeScratchFile(root, destination, content, { replace });
      return;
    }
    writeFileSafely(destination, content, { replace });
  };
  // All validation and parsing happens before this derived-artifact wipe.
  if (existsSync(output.absolute)) rmSync(output.absolute, { recursive: true, force: true });
  mkdirSync(output.absolute, { recursive: true });
  put(resolve(output.absolute, EXPORT_MARKER), EXPORT_MARKER_CONTENT, false);

  const resolveLink = createWikiLinkResolver(fileMap, options.taxonomy.dirAnchors);
  for (const concept of concepts) {
    const body = transformWikiLinks(
      concept.content,
      concept.path,
      resolveLink,
      aliasMap,
      report
    );
    put(resolve(output.absolute, concept.path), stringifyDocument(body, concept.exportedData), true);
  }

  for (const asset of assetFiles) {
    put(resolve(output.absolute, asset.path), readFileSync(resolve(root, asset.path)), true);
  }

  const directories = new Set<string>();
  for (const path of [...markdownFiles, ...assetFiles.map((asset) => asset.path)]) {
    for (const dir of parentDirectories(path)) directories.add(dir);
  }
  directories.add("");
  for (const dir of [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    put(resolve(output.absolute, dir, "index.md"), generateIndex(dir, concepts, directories), true);
    report.indexFilesGenerated++;
  }

  // The exporter's writes into scratch prune it.
  if (scratchOutput) pruneScratch(root);
  return report;
}

function hasFrontmatter(raw: string): boolean {
  return raw.charCodeAt(0) !== 0xfeff && /^---[ \t]*\r?\n/.test(raw);
}

function markdownLinks(content: string): string[] {
  const links: string[] = [];
  replaceMarkdownProse(content, (prose) => {
    const regex = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(prose)) !== null) links.push(match[1].trim());
    return prose;
  });
  return links;
}

function internalLinkExists(root: string, sourcePath: string, target: string): boolean {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    return true;
  }
  const pathPart = target.split("#")[0].split("?")[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return false;
  }
  const candidate = decoded.startsWith("/")
    ? resolve(root, `.${decoded}`)
    : resolve(root, dirname(sourcePath), decoded);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try {
    return statSync(candidate).isFile() || statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function checkIndexStructure(path: string, content: string, issues: OkfCheckIssue[]): void {
  const meaningful = content.split(/\r?\n/).filter((line) => line.trim());
  if (!meaningful.some((line) => /^#\s+\S/.test(line))) {
    issues.push({ severity: "error", path, message: "index.md must contain at least one section heading" });
  }
  for (const line of meaningful) {
    if (/^#\s+\S/.test(line) || /^\* \[[^\]]+\]\([^)]+\)(?: - .+)?$/.test(line)) continue;
    issues.push({ severity: "error", path, message: `invalid index.md listing line: ${line}` });
  }
}

function checkLogStructure(path: string, content: string, issues: OkfCheckIssue[]): void {
  const headings = content.split(/\r?\n/).filter((line) => /^##\s+/.test(line));
  if (headings.length === 0 || headings.some((line) => !/^## \d{4}-\d{2}-\d{2}$/.test(line))) {
    issues.push({ severity: "error", path, message: "log.md date headings must use ## YYYY-MM-DD" });
  }
}

/** Validate any directory as an OKF v0.1 bundle. */
export function checkOkfBundle(directory: string): OkfCheckReport {
  const root = resolve(directory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new OkfExportError(`OKF bundle directory does not exist: ${directory}`);
  }

  const files = [...new Glob("**/*.md").scanSync({ cwd: root })].sort();
  const issues: OkfCheckIssue[] = [];
  for (const path of files) {
    const raw = readFileSync(resolve(root, path), "utf-8");
    const name = basename(path);
    let parsed: ParsedFrontmatter;
    try {
      parsed = parseFrontmatter(raw);
    } catch (error) {
      issues.push({ severity: "error", path, message: `invalid YAML frontmatter: ${(error as Error).message}` });
      continue;
    }

    if (name === "index.md") {
      if (hasFrontmatter(raw)) {
        const keys = Object.keys(parsed.data);
        const rootVersionOnly = path === "index.md" && keys.length === 1 && keys[0] === "okf_version";
        if (!rootVersionOnly) {
          issues.push({ severity: "error", path, message: "index.md must not have frontmatter (except root okf_version only)" });
        }
      }
      // Spec §9(3) makes reserved-file structure normative; this deliberately
      // differs from T7's warning-only suggestion in the handoff plan.
      checkIndexStructure(path, parsed.content, issues);
    } else if (name === "log.md") {
      if (hasFrontmatter(raw)) {
        issues.push({ severity: "error", path, message: "log.md must not have frontmatter" });
      }
      checkLogStructure(path, parsed.content, issues);
    } else {
      if (!hasFrontmatter(raw)) {
        issues.push({ severity: "error", path, message: "concept document is missing YAML frontmatter" });
      } else if (typeof parsed.data.type !== "string" || !parsed.data.type.trim()) {
        issues.push({ severity: "error", path, message: "concept frontmatter requires a non-empty type string" });
      }
    }

    for (const target of markdownLinks(parsed.content)) {
      if (!internalLinkExists(root, path, target)) {
        issues.push({ severity: "warning", path, message: `broken internal markdown link: ${target}` });
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    directory: root,
    ok: errors === 0,
    filesChecked: files.length,
    errors,
    warnings,
    issues,
  };
}
