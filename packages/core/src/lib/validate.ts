/**
 * Frontmatter + wiki-link validation.
 *
 * Ported from the reference brain's scripts/validate.ts as a library (no
 * process.exit / console output): the CLI wraps validate() + checkIndexDrift()
 * and renders the result. Placed in lib/ alongside the other ported libs.
 *
 * CONFIG VALIDATION FIRST: building the Taxonomy handed in here
 * requires loading + schema-validating brain.config (loadUserConfig throws on
 * violations, initContext propagates it). So by the time validate() runs, the
 * config is already known-good; these checks cover the corpus, not the config.
 *
 * Type/status/relevance vocabularies and the wiki-link resolver all come from
 * the taxonomy so validation and the indexer's link graph agree exactly.
 */

import { frontmatterBlock } from "@schlessera/brain-common/internal/frontmatter-block";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

import { VALID_STATUSES, VALID_RELEVANCES } from "./types.js";
import type { Taxonomy } from "./taxonomy.js";
import { createUnresolvedLinkDescriber, createWikiLinkResolver } from "./indexer/links.js";
import { supersedesTargets } from "./supersedes.js";
import {
  getMarkdownFiles,
  resolveAlias,
  extractWikiLinks,
} from "./indexer.js";

export interface ValidationIssue {
  file: string;
  level: "error" | "warning";
  message: string;
}

/**
 * What a validation issue is about, in structured form, so `brain hygiene`
 * can join it to its own findings without reading the message. `rule` names
 * the check; `field`, `target` and `value` are set where the check has one.
 * Never part of `brain validate`'s output: `validate()` drops it.
 */
export interface ValidationDetail {
  rule: ValidationRule;
  /** The frontmatter field the rule checks. */
  field?: string;
  /** A wiki-link or `supersedes` target as written, or a cycle's members joined with `,`. */
  target?: string;
  /** The field's current value as `rawValue()` renders it (`absent` when it is not there), or the tag a tag rule names. */
  value?: string;
}

export type ValidationRule =
  | "frontmatter-missing"
  | "frontmatter-invalid"
  | "required-missing"
  | "type-invalid"
  | "field-invalid"
  | "archived-primary"
  | "tag-format"
  | "tag-alias"
  | "tag-vocabulary"
  | "link-unresolved"
  | "supersedes-unresolved"
  | "supersedes-cycle";

export interface DetailedValidationIssue extends ValidationIssue {
  detail: ValidationDetail;
}

/**
 * A frontmatter value as a deterministic string, for comparing one run with
 * the next: its kind and its content. A cycle (YAML anchors) is cut, never
 * followed, so this cannot throw or loop.
 */
export function rawValue(value: unknown): string {
  if (value === undefined) return "absent";
  const seen = new Set<object>();
  const render = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (v instanceof Date) return `date:${Number.isNaN(v.getTime()) ? "invalid" : v.toISOString()}`;
    if (typeof v === "object") {
      if (seen.has(v)) return "cycle";
      seen.add(v);
      const out = Array.isArray(v)
        ? `[${v.map(render).join(",")}]`
        : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${render((v as Record<string, unknown>)[k])}`).join(",")}}`;
      seen.delete(v);
      return out;
    }
    return `${typeof v}:${typeof v === "string" ? JSON.stringify(v) : String(v)}`;
  };
  return render(value);
}

/**
 * A frontmatter value named by its kind, for a diagnostic. Never serialized:
 * YAML anchors can make a value cyclic, and JSON.stringify throws on that.
 */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "an empty value";
  if (Array.isArray(value)) return "a list";
  if (value instanceof Date) return "a date";
  if (typeof value === "object") return "a map";
  if (typeof value === "string") return "an empty string";
  return `a ${typeof value}`;
}

/**
 * `value` with every string in it copied. A string cut from a file's text
 * (a YAML scalar, a link target) can share that whole text's buffer, so one
 * kept past its file would keep the file's body alive for the rest of the run.
 * The copy keeps every UTF-16 code unit, lone surrogates included.
 */
function own<T>(value: T): T {
  if (typeof value === "string") return value.split("").join("") as T;
  if (Array.isArray(value)) return value.map(own) as T;
  if (value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [own(key), own(entry)])) as T;
  }
  return value;
}

/** The corpus issues, as `brain validate` reports them. */
export function validate(root: string, taxonomy: Taxonomy): ValidationIssue[] {
  return validateDetailed(root, taxonomy).map(({ file, level, message }) => ({ file, level, message }));
}

/** The corpus issues, each with its structured detail (`ValidationDetail`). */
export function validateDetailed(root: string, taxonomy: Taxonomy): DetailedValidationIssue[] {
  const issues: DetailedValidationIssue[] = [];
  const files = getMarkdownFiles(root, taxonomy);
  const tagAliases = taxonomy.tags?.aliases;
  const vocabulary = taxonomy.tags?.vocabulary ? new Set(taxonomy.tags.vocabulary) : null;

  // Build the same maps the indexer uses, so validation and resolution agree
  const fileMap = new Map<string, string>(files.map((path) => [path, path]));
  const aliasMap = new Map<string, string[]>();
  // `supersedes` values as written, checked once every file is known.
  const supersedes = new Map<string, unknown>();
  const resolveLink = createWikiLinkResolver(fileMap, taxonomy.dirAnchors);
  const describeUnresolved = createUnresolvedLinkDescriber(files);

  // One read and one frontmatter parse per file (#4785). Everything but an
  // alias link is judged as the file is read; a link that resolves to no path
  // waits, as a copied string, until every file's aliases are known. Nothing
  // kept past its file shares that file's text (see `own`).
  const checked: Array<{ file: string; issues: DetailedValidationIssue[]; aliasLinks: string[] }> = [];
  for (const filePath of files) {
    const raw = readFileSync(resolve(root, filePath), "utf-8");
    const fileIssues: DetailedValidationIssue[] = [];
    const aliasLinks: string[] = [];
    checked.push({ file: filePath, issues: fileIssues, aliasLinks });

    let parsed: { data: Record<string, any>; content: string } | null = null;
    let parseError: unknown;
    try {
      parsed = parseFrontmatter(raw, { dataOnly: true });
    } catch (e) {
      parseError = e;
    }
    // Aliases and `supersedes` count whatever the fences look like, and a
    // value that cannot be read stops only this file's collection.
    if (parsed) {
      try {
        const { data } = parsed;
        if (data.supersedes !== undefined) supersedes.set(filePath, own(data.supersedes));
        if (Array.isArray(data.aliases)) {
          for (const alias of data.aliases) {
            const key = own(String(alias).toLowerCase().trim());
            if (!key) continue;
            const paths = aliasMap.get(key) ?? [];
            paths.push(filePath);
            aliasMap.set(key, paths);
          }
        }
      } catch {
        // the per-file checks below report what is wrong with the frontmatter
      }
    }

    // Check for frontmatter, by the fences the indexer reads (#2507): a
    // byte order mark before them is fine, a `----` line is not a fence.
    if (!frontmatterBlock(raw)) {
      fileIssues.push({
        file: filePath,
        level: "error",
        message: "Missing YAML frontmatter",
        detail: { rule: "frontmatter-missing" },
      });
      continue;
    }

    if (!parsed) {
      fileIssues.push({
        file: filePath,
        level: "error",
        message: `Invalid YAML frontmatter: ${parseError}`,
        detail: { rule: "frontmatter-invalid" },
      });
      continue;
    }
    const { data, content } = parsed;
    // The field a rule checks, with its value as written.
    const about = (field: string) => ({ field, value: rawValue(Object.hasOwn(data, field) ? data[field] : undefined) });

    // Required fields
    if (!data.title) {
      fileIssues.push({
        file: filePath,
        level: "error",
        message: "Missing required field: title",
        detail: { rule: "required-missing", ...about("title") },
      });
    }
    if (!data.type) {
      fileIssues.push({
        file: filePath,
        level: "error",
        message: "Missing required field: type",
        detail: { rule: "required-missing", ...about("type") },
      });
    } else if (!taxonomy.isValidType(data.type)) {
      fileIssues.push({
        file: filePath,
        level: "error",
        message: `Invalid type: "${data.type}". Valid: ${taxonomy.validTypes().join(", ")}`,
        detail: { rule: "type-invalid", ...about("type") },
      });
    }
    if (!data.created) {
      fileIssues.push({
        file: filePath,
        level: "warning",
        message: "Missing field: created",
        detail: { rule: "required-missing", ...about("created") },
      });
    }
    if (!data.updated) {
      fileIssues.push({
        file: filePath,
        level: "warning",
        message: "Missing field: updated",
        detail: { rule: "required-missing", ...about("updated") },
      });
    }
    if (!data.tags || !Array.isArray(data.tags) || data.tags.length === 0) {
      fileIssues.push({
        file: filePath,
        level: "warning",
        message: "Missing or empty tags",
        detail: { rule: "required-missing", ...about("tags") },
      });
    }

    // Optional field validation
    if (data.status && !VALID_STATUSES.includes(data.status)) {
      fileIssues.push({
        file: filePath,
        level: "error",
        message: `Invalid status: "${data.status}". Valid: ${VALID_STATUSES.join(", ")}`,
        detail: { rule: "field-invalid", ...about("status") },
      });
    }
    if (data.relevance && !VALID_RELEVANCES.includes(data.relevance)) {
      fileIssues.push({
        file: filePath,
        level: "error",
        message: `Invalid relevance: "${data.relevance}". Valid: ${VALID_RELEVANCES.join(", ")}`,
        detail: { rule: "field-invalid", ...about("relevance") },
      });
    }
    if ("generated_from" in data && (typeof data.generated_from !== "string" || data.generated_from.trim() === "")) {
      fileIssues.push({
        file: filePath,
        level: "error",
        message: `Invalid generated_from: ${describeValue(data.generated_from)}. It must be a non-empty string: a repo-relative path or a tool name`,
        detail: { rule: "field-invalid", ...about("generated_from") },
      });
    }
    for (const field of ["propagation_scope", "propagation_reference"]) {
      if (field in data && (typeof data[field] !== "string" || !data[field].trim() || (field === "propagation_scope" && data[field].length > 4000) ||
        (field === "propagation_reference" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(data[field])))) {
        fileIssues.push({ file: filePath, level: "error", message: `Invalid ${field}: expected ${field === "propagation_reference" ? "a full Git commit ID" : "a non-empty scope string"}`,
          detail: { rule: "field-invalid", ...about(field) } });
      }
    }
    // `verification` (#394): `unverified` is the one value brain reads. Any
    // other would read as a claim (say, "verified") that nothing checks.
    if ("verification" in data && data.verification !== "unverified") {
      fileIssues.push({
        file: filePath,
        level: "warning",
        message: `Unrecognised verification: ${typeof data.verification === "string" ? `"${data.verification}"` : describeValue(data.verification)}. The only value brain reads is "unverified"; otherwise leave the field out`,
        detail: { rule: "field-invalid", ...about("verification") },
      });
    }
    if (data.status === "archived" && data.relevance === "primary") {
      fileIssues.push({
        file: filePath,
        level: "warning",
        message: "status: archived contradicts relevance: primary; set relevance: historical",
        detail: { rule: "archived-primary", field: "relevance", value: rawValue(data.relevance) },
      });
    }

    // Tag format validation, then the configured vocabulary (taxonomy.tags)
    if (Array.isArray(data.tags)) {
      for (const tag of data.tags) {
        if (typeof tag !== "string" || tag !== tag.toLowerCase() || tag.includes(" ")) {
          fileIssues.push({
            file: filePath,
            level: "warning",
            message: `Tag "${tag}" should be lowercase and hyphenated (no spaces)`,
            detail: { rule: "tag-format", field: "tags", value: String(tag) },
          });
        }
        const name = String(tag);
        if (tagAliases && Object.hasOwn(tagAliases, name)) {
          fileIssues.push({
            file: filePath,
            level: "warning",
            message: `Tag "${name}" is an alias in taxonomy.tags — use "${tagAliases[name]}"`,
            detail: { rule: "tag-alias", field: "tags", value: name },
          });
        } else if (vocabulary && !vocabulary.has(name)) {
          fileIssues.push({
            file: filePath,
            level: "warning",
            message: `Tag "${name}" is not in taxonomy.tags.vocabulary`,
            detail: { rule: "tag-vocabulary", field: "tags", value: name },
          });
        }
      }
    }

    // Wiki-link validation — uses the indexer's resolver so warnings match
    // what the link graph will actually contain
    for (const link of extractWikiLinks(content)) {
      if (!resolveLink(link, filePath)) aliasLinks.push(own(link));
    }
  }

  for (const { file, issues: fileIssues, aliasLinks } of checked) {
    issues.push(...fileIssues);
    for (const link of aliasLinks) {
      if (resolveAlias(link, aliasMap, file)) continue;
      // `brain audit` words its broken-link findings with the same describer.
      issues.push({ file, level: "warning", message: describeUnresolved(link), detail: { rule: "link-unresolved", target: link } });
    }
  }

  issues.push(...validateSupersedes(supersedes, (target, from) => resolveLink(target, from) ?? resolveAlias(target, aliasMap, from)));
  return issues;
}

/**
 * `supersedes` (#412): each value must be a wiki-link target or a list of
 * them, each target must resolve, and no document may end up superseding
 * itself through a chain. All three are errors: a wrong entry silently
 * demotes nothing, or the wrong document.
 */
function validateSupersedes(
  values: Map<string, unknown>,
  resolveTarget: (target: string, from: string) => string | null
): DetailedValidationIssue[] {
  const issues: DetailedValidationIssue[] = [];
  const edges = new Map<string, string[]>();
  for (const [file, value] of values) {
    const targets = supersedesTargets(value);
    if (targets === null) {
      issues.push({
        file,
        level: "error",
        message: `Invalid supersedes: ${describeValue(value)}. It must be one wiki-link target, "[[target]]" or target, or a non-empty list of them`,
        detail: { rule: "field-invalid", field: "supersedes", value: rawValue(value) },
      });
      continue;
    }
    const resolved: string[] = [];
    for (const target of targets) {
      const path = resolveTarget(target, file);
      if (path) resolved.push(path);
      else issues.push({ file, level: "error", message: `Unresolved supersedes target: [[${target}]]`, detail: { rule: "supersedes-unresolved", field: "supersedes", target } });
    }
    edges.set(file, resolved);
  }

  // Every document on a cycle is reported, once, naming the others it loops
  // with: the cycles are the strongly connected components (Tarjan) of more
  // than one document, or one that supersedes itself.
  for (const component of stronglyConnected(edges)) {
    const looped = component.length > 1 || (edges.get(component[0]!) ?? []).includes(component[0]!);
    if (!looped) continue;
    const members = [...component].sort();
    for (const file of members) {
      issues.push({
        file,
        level: "error",
        message: `supersedes cycle among ${members.join(", ")}`,
        detail: { rule: "supersedes-cycle", field: "supersedes", target: members.join(",") },
      });
    }
  }
  return issues;
}

/** The strongly connected components of a graph (Tarjan's algorithm). */
function stronglyConnected(edges: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let next = 0;
  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next++;
    stack.push(node);
    onStack.add(node);
    for (const to of edges.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node)!, index.get(to)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  };
  for (const node of edges.keys()) if (!index.has(node)) visit(node);
  return components;
}

/**
 * Index drift check: compare markdown files on disk against the documents
 * table in brain.db. Skipped silently when the database doesn't exist.
 * Uses the indexer's own file-scanning rules so the comparison is 1:1.
 */
export async function checkIndexDrift(
  root: string,
  dbPath: string,
  taxonomy: Taxonomy
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  if (!existsSync(dbPath)) return issues;

  try {
    const { openDatabase } = await import("./db.js");

    const db = openDatabase(dbPath, { readonly: true });
    const dbPaths = new Set(
      (db.prepare("SELECT path FROM documents WHERE asset_type = 'markdown'").all() as { path: string }[])
        .map((r) => r.path)
    );
    db.close();

    const diskPaths = new Set(getMarkdownFiles(root, taxonomy));

    for (const path of diskPaths) {
      if (!dbPaths.has(path)) {
        issues.push({
          file: path,
          level: "warning",
          message: "Not in search index — run `brain index`",
        });
      }
    }
    for (const path of dbPaths) {
      if (!diskPaths.has(path)) {
        issues.push({
          file: path,
          level: "warning",
          message: "Stale index entry (file no longer on disk) — run `brain index`",
        });
      }
    }
  } catch {
    // DB unreadable or locked — drift check is best-effort
  }

  return issues;
}
