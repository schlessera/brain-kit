/**
 * Read-only in-flight collision report (#2941). Detection only: no locks,
 * reservations or messages between workers.
 *
 * Open PR heads are trial-merged pairwise with `git merge-tree --write-tree`
 * (objects only; never a ref, the index or the working tree) and their
 * affected closures are compared with the CI selection code: reverse manifest
 * dependants (`planUnitChecks`) and runnable unit owners of the changed import
 * targets (`unitImportOwners`). One import graph is built from this checkout
 * and reused for every PR. A graph that cannot be built reports `unknown`,
 * never disjoint.
 *
 *   bun scripts/collisions.ts [--json] [--pr <n> | --paths <glob...>] [--no-fetch] [--repo owner/name]
 */
import { spawnSync } from "node:child_process";
import { changedFiles, planUnitChecks, workspaces, type CheckPlan, type Workspace } from "./ci-plan";
import { discoverUnitImports, unitImportOwners, type UnitImportGraph } from "./unit-test-consumers";

export interface OpenPr { number: number; head: string; base: string; draft: boolean; baseRef?: string }

export interface PrRef { number: number; head: string }

export type CollisionKind = "textual" | "path" | "closure" | "unknown";

export interface Collision {
  kind: CollisionKind;
  /** Two PRs for pairwise reports; one PR for a `--paths` query. */
  prs: PrRef[];
  /** Conflicting paths (textual), matched paths (path) or overlapping closure paths (closure). */
  paths: string[];
  /** Proof categories both sides select; empty when unknown. */
  categories: string[];
  /** Workspaces in both affected closures. */
  workspaces: string[];
  reason?: string;
}

export interface CollisionReport {
  /** Commit of the checkout whose import graph was compared. */
  graph: { commit: string; status: "built" | "unknown"; reason?: string };
  mode: "all" | "pr" | "paths";
  query?: { pr?: number; paths?: string[] };
  prs: Array<PrRef & { draft: boolean; changed?: number; reason?: string }>;
  collisions: Collision[];
}

export interface CollisionOptions {
  root: string;
  /** Injectable PR listing; the CLI uses `gh pr list`. Tests never reach the network. */
  listPrs: () => Promise<OpenPr[]> | OpenPr[];
  pr?: number;
  paths?: string[];
  /** Fetch missing PR objects without writing refs or FETCH_HEAD. */
  fetch?: boolean;
  remote?: string;
  /** Injectable for tests; defaults to the CI selection graph builder. */
  buildGraph?: (root: string) => UnitImportGraph;
}

interface Closure { changed: string[]; owners: Set<string>; affected: Set<string>; categories: Set<string>; global: boolean }

function git(root: string, args: string[], allow: number[] = [0]) {
  // GIT_OPTIONAL_LOCKS=0 keeps even status-style refreshes from rewriting the index.
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.error || !allow.includes(result.status ?? -1))
    throw new Error(`git ${args[0]} failed: ${(result.stderr || String(result.error ?? "")).trim()}`);
  return { status: result.status!, stdout: result.stdout };
}

const hasCommit = (root: string, sha: string) => git(root, ["cat-file", "-e", `${sha}^{commit}`], [0, 1, 128]).status === 0;

/** Objects only: no destination refspec, no FETCH_HEAD, no opportunistic tracking update, no maintenance. */
function fetchMissing(root: string, remote: string, prs: readonly OpenPr[]) {
  const wanted = prs.flatMap(pr => [
    ...(hasCommit(root, pr.head) ? [] : [`refs/pull/${pr.number}/head`]),
    ...(hasCommit(root, pr.base) || !pr.baseRef ? [] : [`refs/heads/${pr.baseRef}`]),
  ]);
  if (!wanted.length) return;
  git(root, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", "--no-auto-maintenance",
    "--no-recurse-submodules", remote, ...new Set(wanted)], [0, 1, 128]);
}

/** Pure set comparison; `undefined` on either side means the closure is unknown. */
export function compareClosures(a: Closure | undefined, b: Closure | undefined):
    { status: "overlap" | "disjoint" | "unknown"; paths: string[]; workspaces: string[]; categories: string[] } {
  if (!a || !b) return { status: "unknown", paths: [], workspaces: [], categories: [] };
  const inputs = (c: Closure) => new Set([...c.changed, ...c.owners]);
  const left = inputs(a), right = inputs(b);
  const paths = [...left].filter(path => right.has(path)).sort();
  const shared = [...a.affected].filter(dir => b.affected.has(dir)).sort();
  const categories = [...a.categories].filter(name => b.categories.has(name)).sort();
  return { status: paths.length || shared.length ? "overlap" : "disjoint", paths, workspaces: shared, categories };
}

function categoriesOf(plan: CheckPlan): Set<string> {
  return new Set([...(plan.typecheck ? ["typecheck"] : []), ...(plan.pack ? ["pack"] : []),
    ...Object.entries(plan.local).filter(([, on]) => on).map(([name]) => name === "fullTests" ? "unit" : name)]);
}

function closureOf(changed: string[], root: string, packages: Workspace[], graph: UnitImportGraph): Closure {
  const plan = planUnitChecks(changed, packages, root, graph);
  // Universal fallback owners (unresolved imports) join every selection, so they
  // are common to all PRs and not evidence of overlap; owners here are only the
  // runnable consumers of this PR's own changed inputs.
  return { changed, owners: new Set(unitImportOwners(graph, changed)), affected: new Set(plan.affected),
    categories: categoriesOf(plan), global: plan.global };
}

export async function collisions(options: CollisionOptions): Promise<CollisionReport> {
  const { root } = options;
  const listed = await options.listPrs();
  if (options.pr !== undefined && !listed.some(pr => pr.number === options.pr))
    throw new Error(`PR #${options.pr} is not an open PR of this repository`);
  if (options.fetch) fetchMissing(root, options.remote ?? "origin", listed);
  const commit = git(root, ["rev-parse", "HEAD"]).stdout.trim();

  let graph: UnitImportGraph | undefined, graphReason: string | undefined, packages: Workspace[] = [];
  try { packages = workspaces(root); graph = (options.buildGraph ?? discoverUnitImports)(root); }
  catch (error) { graphReason = `Selection graph unavailable: ${error instanceof Error ? error.message : String(error)}`; }

  const changed = new Map<number, string[]>(), reasons = new Map<number, string>(), closures = new Map<number, Closure>();
  for (const pr of listed) {
    if (!hasCommit(root, pr.head) || !hasCommit(root, pr.base)) { reasons.set(pr.number, "Head or base commit unavailable locally"); continue; }
    try { changed.set(pr.number, changedFiles(root, pr.base, pr.head)); }
    catch (error) { reasons.set(pr.number, String(error instanceof Error ? error.message : error)); }
  }
  const closure = (key: number, files: string[] | undefined) => {
    if (!graph || !files) return undefined;
    if (!closures.has(key)) {
      try { closures.set(key, closureOf(files, root, packages, graph)); }
      catch (error) { reasons.set(key, `Closure unavailable: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
    }
    return closures.get(key);
  };
  const unknownReason = (...keys: number[]) => graphReason ?? keys.map(key => reasons.get(key)).find(Boolean) ?? "Closure unavailable";
  const ref = (pr: OpenPr): PrRef => ({ number: pr.number, head: pr.head });
  const found: Collision[] = [];

  if (options.paths) {
    const globs = options.paths.map(pattern => new Bun.Glob(pattern));
    const tracked = git(root, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
    const literal = options.paths.filter(pattern => !/[*?[\]{}!]/.test(pattern));
    const query = [...new Set([...tracked.filter(path => globs.some(glob => glob.match(path))), ...literal])].sort();
    const QUERY = -1;
    for (const pr of listed) {
      const files = changed.get(pr.number);
      const touched = files?.filter(path => globs.some(glob => glob.match(path))) ?? [];
      if (touched.length) { found.push({ kind: "path", prs: [ref(pr)], paths: touched, categories: [], workspaces: [] }); continue; }
      const compared = compareClosures(closure(QUERY, query), closure(pr.number, files));
      if (compared.status === "overlap") found.push({ kind: "closure", prs: [ref(pr)], paths: compared.paths, categories: compared.categories, workspaces: compared.workspaces });
      else if (compared.status === "unknown") found.push({ kind: "unknown", prs: [ref(pr)], paths: [], categories: [], workspaces: [], reason: unknownReason(QUERY, pr.number) });
    }
  } else {
    for (let i = 0; i < listed.length; i++) for (let j = i + 1; j < listed.length; j++) {
      const a = listed[i]!, b = listed[j]!;
      if (options.pr !== undefined && a.number !== options.pr && b.number !== options.pr) continue;
      const prs = [ref(a), ref(b)];
      if (!changed.has(a.number) || !changed.has(b.number)) {
        found.push({ kind: "unknown", prs, paths: [], categories: [], workspaces: [], reason: unknownReason(a.number, b.number) });
        continue;
      }
      // Exit 1 is a conflicted merge; anything else is an error, which is unknown rather than clean.
      const merge = (() => {
        try { return git(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a.head, b.head], [0, 1]); }
        catch (error) { return error as Error; }
      })();
      if (merge instanceof Error) {
        found.push({ kind: "unknown", prs, paths: [], categories: [], workspaces: [], reason: `Trial merge failed: ${merge.message}` });
        continue;
      }
      // Heads on different bases also conflict where only base drift differs
      // (the other side carries newer main). A pairwise conflict needs a path
      // both PRs changed; drift-only conflicts belong to each PR's own refresh.
      const both = new Set(changed.get(a.number)!.filter(path => changed.get(b.number)!.includes(path)));
      const paths = merge.status === 1 ? [...new Set(merge.stdout.split("\0").filter(Boolean).slice(1))].filter(path => both.has(path)).sort() : [];
      if (paths.length) {
        found.push({ kind: "textual", prs, paths, categories: [], workspaces: [] });
        continue;
      }
      const compared = compareClosures(closure(a.number, changed.get(a.number)), closure(b.number, changed.get(b.number)));
      if (compared.status === "overlap") found.push({ kind: "closure", prs, paths: compared.paths, categories: compared.categories, workspaces: compared.workspaces });
      else if (compared.status === "unknown") found.push({ kind: "unknown", prs, paths: [], categories: [], workspaces: [], reason: unknownReason(a.number, b.number) });
    }
  }

  return {
    graph: { commit, status: graph ? "built" : "unknown", ...(graphReason ? { reason: graphReason } : {}) },
    mode: options.paths ? "paths" : options.pr !== undefined ? "pr" : "all",
    ...(options.paths ? { query: { paths: options.paths } } : options.pr !== undefined ? { query: { pr: options.pr } } : {}),
    prs: listed.map(pr => ({ ...ref(pr), draft: pr.draft,
      ...(changed.has(pr.number) ? { changed: changed.get(pr.number)!.length } : {}),
      ...(reasons.has(pr.number) ? { reason: reasons.get(pr.number) } : {}) })),
    collisions: found,
  };
}

/** Open ready and draft PRs from `gh`; heads from forks are compared like any other head. */
export function githubPrs(root: string, repo?: string): OpenPr[] {
  const result = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "1000", ...(repo ? ["--repo", repo] : []),
    "--json", "number,headRefOid,baseRefOid,baseRefName,isDraft"], { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`gh pr list failed: ${(result.stderr || String(result.error)).trim()}`);
  return (JSON.parse(result.stdout) as Array<{ number: number; headRefOid: string; baseRefOid: string; baseRefName: string; isDraft: boolean }>)
    .map(pr => ({ number: pr.number, head: pr.headRefOid, base: pr.baseRefOid, baseRef: pr.baseRefName, draft: pr.isDraft }))
    .sort((a, b) => a.number - b.number);
}

export function formatReport(report: CollisionReport): string {
  const name = (pr: PrRef) => `#${pr.number}@${pr.head.slice(0, 9)}`;
  const list = (values: string[]) => values.length > 8 ? `${values.slice(0, 8).join(", ")} (+${values.length - 8} more; see --json)` : values.join(", ");
  const lines = [`graph ${report.graph.status} at ${report.graph.commit.slice(0, 9)}${report.graph.reason ? ` (${report.graph.reason})` : ""}; ${report.prs.length} open PRs`];
  if (!report.collisions.length) lines.push("no collisions");
  for (const c of report.collisions) {
    const detail = c.kind === "unknown" ? c.reason : [c.paths.length ? `paths ${list(c.paths)}` : "",
      c.workspaces.length ? `workspaces ${c.workspaces.join(", ")}` : "", c.categories.length ? `categories ${c.categories.join(", ")}` : ""].filter(Boolean).join("; ");
    lines.push(`${c.kind.padEnd(8)} ${c.prs.map(name).join(" x ")}${detail ? `  ${detail}` : ""}`);
  }
  return lines.join("\n");
}

const USAGE = "Usage: bun scripts/collisions.ts [--json] [--pr <n> | --paths <glob...>] [--no-fetch] [--repo owner/name]";

export function parseArgs(argv: readonly string[]): { json: boolean; fetch: boolean; pr?: number; paths?: string[]; repo?: string } {
  const out: ReturnType<typeof parseArgs> = { json: false, fetch: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") out.json = true;
    else if (arg === "--no-fetch") out.fetch = false;
    else if (arg === "--pr") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error(USAGE);
      out.pr = value;
    } else if (arg === "--repo") { out.repo = argv[++i]; if (!out.repo) throw new Error(USAGE); }
    else if (arg === "--paths") {
      out.paths = [];
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) out.paths.push(argv[++i]!);
      if (!out.paths.length) throw new Error(USAGE);
    } else throw new Error(USAGE);
  }
  if (out.pr !== undefined && out.paths) throw new Error(USAGE);
  return out;
}

if (import.meta.main) {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).stdout.trim();
  try {
    const report = await collisions({ root, listPrs: () => githubPrs(root, args.repo), pr: args.pr, paths: args.paths, fetch: args.fetch });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
