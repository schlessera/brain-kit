import { openDatabase, migrateVecSchema, storedVectorWidth } from "../../lib/db.js";
import { indexAll } from "../../lib/indexer.js";
import { syncSkills } from "../../lib/skills/index.js";
import type { Taxonomy } from "../../lib/taxonomy.js";
import type { CoreCommand, CliContext } from "../types.js";
import { emit, embeddingDims, UsageError } from "../io.js";
import { runAgent } from "../agent.js";
import { resolveEmitters } from "../skills-util.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const HELP = `brain sync [verb] — knowledge-aware brain synchronization

With no verb, delegates the full workflow to the coding agent (/sync skill).
Mechanical verbs (structured output for the skill to drive):

  assess       Classify local changes (SENSITIVE|ARTIFACT|DERIVED|TRACK|UNKNOWN)
  group        Group tracked changes by taxonomy domain
  pull         Fetch origin/main and fast-forward or merge
  conflicts    Emit BASE/OURS/THEIRS for each conflicted file
  push         Push to origin/main
  post-sync    Re-sync skills + reindex, commit the derived caches it rewrote,
               then report head parity and any remaining working-tree dirt`;

// Artifact + sensitive path globs (ported from sync.sh). No personal patterns.
const ARTIFACT_PATTERNS = [
  "*.pyc", "__pycache__/*", "*.db-shm", "*.db-wal", "tmp/*", "*.log",
  "*.swp", "*.swo", "*~", ".DS_Store", "Desktop.ini", "Thumbs.db", "*.pptx",
];
const SENSITIVE_PATTERNS = [
  ".env", ".env.*", "credentials*", "*.key", "*.pem", "*.secret", "*_secret*", "*_token*",
];
const TRACKABLE_EXTS = new Set([
  "md", "ts", "sh", "js", "json", "yaml", "yml", "toml", "css", "html", "py", "txt",
]);
const CONFIG_FILES = new Set([
  ".gitignore", "CLAUDE.md", "README.md", "AGENTS.md", "package.json", "bun.lock", "bun.lockb", "tsconfig.json",
]);

/**
 * Sidecars that an embeddings index run rewrites (see `saveContextCache` /
 * `saveAssetCache` in lib/indexer). They are derived from brain.db but are
 * committed so fresh clones and rebuilds skip regeneration — which means the
 * reindex at the end of a sync routinely dirties the tree *after* the push.
 * post-sync owns that dirt and commits it itself.
 */
const DERIVED_CACHES = new Set([".context-cache.jsonl", ".asset-cache.jsonl"]);

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function git(root: string, args: string[], raw = false): GitResult {
  const proc = Bun.spawnSync(["git", "-C", root, ...args]);
  return {
    stdout: raw ? new TextDecoder().decode(proc.stdout) : new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
    code: proc.exitCode ?? 0,
  };
}

/**
 * One record per `git status` entry: the two-character code and the path.
 *
 * `--porcelain=v1 -z` rather than the default: NUL-separated records keep the
 * leading space of an unstaged code (` M path`) that trimming would eat, and
 * paths arrive literal — no quoting, no ` -> ` arrow to re-split, so a path
 * containing either is not mis-parsed. Renames and copies emit the destination
 * first and the original as the following record, which is skipped.
 */
function porcelainRecords(root: string): { xy: string; file: string }[] {
  const result = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], true);
  if (result.code !== 0) throw new UsageError(`Git status failed: ${result.stderr}`);
  const records = result.stdout.split("\0");
  const entries: { xy: string; file: string }[] = [];
  for (let i = 0; i < records.length; i++) {
    const line = records[i]!;
    if (!line) continue;
    const xy = line.slice(0, 2);
    entries.push({ xy, file: line.slice(3) });
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return entries;
}

function globToRegex(pattern: string): RegExp {
  const body = pattern
    .split(/(\*)/)
    .map((p) => (p === "*" ? ".*" : p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

function matchesAny(file: string, patterns: string[]): boolean {
  const base = file.split("/").pop() ?? file;
  return patterns.some((p) => {
    const re = globToRegex(p);
    return re.test(file) || re.test(base);
  });
}

function isTrackable(file: string): boolean {
  const ext = file.includes(".") ? file.split(".").pop()! : "";
  if (TRACKABLE_EXTS.has(ext)) return true;
  if (file.startsWith(".claude/skills/") || file.startsWith(".agents/skills/") || file.startsWith("scripts/")) {
    return true;
  }
  return CONFIG_FILES.has(file);
}

/** Domain for a tracked path: special dirs → skills/config, else the doc type. */
function domainFor(path: string, taxonomy: Taxonomy): string {
  if (path.startsWith(".agents/skills/") || path.startsWith(".claude/skills/") || path.startsWith("scripts/")) {
    return "skills";
  }
  if (CONFIG_FILES.has(path)) return "config";
  return taxonomy.typeForPath(path);
}

function currentBranch(root: string): string {
  return git(root, ["branch", "--show-current"]).stdout || "(detached HEAD)";
}

interface AssessedFile {
  status: string;
  class: "SENSITIVE" | "ARTIFACT" | "DERIVED" | "TRACK" | "UNKNOWN";
  path: string;
}

function assess(root: string): AssessedFile[] {
  const files: AssessedFile[] = [];
  for (const { xy, file } of porcelainRecords(root)) {

    let status: string;
    const trimmed = xy.trim();
    if (xy === "??") status = "?";
    else if (trimmed.startsWith("A")) status = "A";
    else if (trimmed.startsWith("M") || xy === "MM") status = "M";
    else if (trimmed.startsWith("D")) status = "D";
    else if (trimmed.startsWith("R")) status = "R";
    else status = trimmed;

    // Skip already-ignored files silently.
    if (git(root, ["check-ignore", "-q", "--", file]).code === 0) continue;

    let klass: AssessedFile["class"];
    if (matchesAny(file, SENSITIVE_PATTERNS)) klass = "SENSITIVE";
    else if (matchesAny(file, ARTIFACT_PATTERNS)) klass = "ARTIFACT";
    // Committed on purpose, but post-sync commits them after its reindex —
    // taking them here too would just commit a stale copy and duplicate work.
    else if (DERIVED_CACHES.has(file)) klass = "DERIVED";
    else if (isTrackable(file)) klass = "TRACK";
    else klass = "UNKNOWN";

    files.push({ status, class: klass, path: file });
  }
  return files;
}

function workingTreeDirt(root: string): string[] {
  return porcelainRecords(root).map((record) => record.file);
}

export interface DirtDisposition {
  /** Derived sidecars post-sync rewrote — safe for it to commit unattended. */
  caches: string[];
  /** Everything else — reported, never auto-committed. */
  other: string[];
}

/**
 * Split post-reindex working-tree dirt into what post-sync may commit itself
 * and what only a human/agent should decide about. Pure so the policy is
 * testable without a git fixture or an API key.
 */
export function classifyPostSyncDirt(dirty: string[]): DirtDisposition {
  const caches: string[] = [];
  const other: string[] = [];
  for (const file of dirty) (DERIVED_CACHES.has(file) ? caches : other).push(file);
  return { caches, other };
}

/**
 * Set local changes to the derived caches aside so a merge can touch them, and
 * return what this clone had in each. Hooks off: restoring a file fires
 * post-checkout, whose reindex can rewrite the cache straight back.
 */
function setDerivedCachesAside(root: string): Map<string, string> {
  const aside = new Map<string, string>();
  for (const file of classifyPostSyncDirt(workingTreeDirt(root)).caches) {
    const path = resolve(root, file);
    aside.set(file, existsSync(path) ? readFileSync(path, "utf-8") : "");
    if (git(root, ["cat-file", "-e", `HEAD:${file}`]).code === 0) {
      git(root, ["-c", "core.hooksPath=/dev/null", "restore", "--source=HEAD", "--staged", "--worktree", "--", file]);
    } else {
      git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", file]);
      rmSync(path, { force: true });
    }
  }
  return aside;
}

/**
 * Union this clone's entries back into each cache the merge left behind. The
 * merged copy wins a shared key. An entry only this clone has may belong to a
 * chunk the merge re-chunks, and the reindex can recover it only from the file.
 */
function unionDerivedCaches(root: string, aside: Map<string, string>): void {
  for (const [file, ours] of aside) {
    const path = resolve(root, file);
    const merged = existsSync(path) ? readFileSync(path, "utf-8") : "";
    const byKey = new Map<string, string>();
    for (const line of `${merged}\n${ours}`.split("\n")) {
      if (!line.trim()) continue;
      try {
        const { k } = JSON.parse(line) as { k?: unknown };
        if (typeof k === "string" && !byKey.has(k)) byKey.set(k, line);
      } catch {
        // skip malformed line
      }
    }
    const lines = [...byKey.values()].sort();
    writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
  }
}

/**
 * Commit and push the derived caches post-sync rewrote, and nothing else.
 * Returns the outcome reported as `cacheCommit`.
 */
export function commitDerivedCaches(root: string, caches: string[], branch: string): string {
  if (caches.length === 0) return "clean";
  if (branch !== "main") return `skipped — not on main (${branch})`;
  // Stage and commit by explicit path. `--only` builds the commit from HEAD
  // plus these paths, so anything already staged stays staged and out of it.
  // A deletion already staged has nothing left to add, and `add` would fail.
  const stageable = caches.filter(
    (file) => existsSync(resolve(root, file)) || git(root, ["ls-files", "--error-unmatch", "--", file]).code === 0
  );
  const staged = stageable.length > 0 ? git(root, ["add", "--", ...stageable]) : { code: 0, stderr: "" };
  if (staged.code !== 0) return `FAILED to stage — ${staged.stderr}`;
  const committed = git(root, ["commit", "--only", "-m", "Refresh derived index caches", "--", ...caches]);
  if (committed.code !== 0) return `FAILED to commit — ${committed.stderr || committed.stdout}`;
  const pushed = git(root, ["push", "origin", "main"]);
  return pushed.code === 0
    ? `committed + pushed (${caches.join(", ")})`
    : `committed, push rejected — ${pushed.stderr || pushed.stdout}`;
}

async function postSync(cli: CliContext): Promise<Record<string, unknown>> {
  const root = cli.brain.root;
  const { emitters, warnings } = resolveEmitters(cli.brain);
  let skills: string;
  try {
    const res = syncSkills({ root, modules: cli.brain.modules }, { emitters });
    skills = `ok — ${res.materialized.length} materialized, ${res.pruned.length} pruned`;
    warnings.push(...res.warnings);
  } catch (e) {
    skills = `FAILED — ${(e as Error).message}`;
  }

  let index: string;
  try {
    const dims = embeddingDims(cli.embeddings);
    const db = openDatabase(cli.brain.dbPath, { embeddingDimensions: dims });
    await migrateVecSchema(db, storedVectorWidth(db, dims));
    const wantEmbeddings = !!cli.embeddings;
    await indexAll(db, {
      root,
      taxonomy: cli.brain.taxonomy,
      force: false,
      quiet: true,
      embeddings: wantEmbeddings,
      provider: wantEmbeddings ? cli.embeddings : undefined,
      enrichment: wantEmbeddings ? cli.enrichment : undefined,
    });
    db.close();
    index = "ok";
  } catch (e) {
    index = `FAILED — ${(e as Error).message}`;
  }

  // The reindex above rewrites the derived sidecars, so the tree is routinely
  // dirty at this point — after the push. Commit and push those caches here so
  // a sync ends clean instead of leaving the caller to notice and do it.
  const branch = currentBranch(root);
  const { caches, other } = classifyPostSyncDirt(workingTreeDirt(root));
  const cacheCommit = commitDerivedCaches(root, caches, branch);

  const localHead = git(root, ["rev-parse", "--short", "HEAD"]).stdout;
  const remoteHead = git(root, ["rev-parse", "--short", "origin/main"]).stdout || "unknown";

  // "complete" must mean complete: heads agree *and* nothing is left behind.
  // Anything the caches step could not finish leaves the tree dirty too.
  const cacheUnresolved = cacheCommit.startsWith("FAILED") || cacheCommit.startsWith("skipped");
  let sync: string;
  if (localHead !== remoteHead) sync = "diverged";
  else if (other.length > 0 || cacheUnresolved) sync = "dirty";
  else sync = "complete";

  return {
    skills,
    index,
    cacheCommit,
    treeDirty: other,
    branch,
    localHead,
    remoteHead,
    sync,
    warnings,
  };
}

export const syncCommand: CoreCommand = {
  summary: "Sync the brain with its git remote (mechanical verbs for the /sync skill)",
  helpBlock: HELP,
  async run(args, cli): Promise<number | void> {
    const root = cli.brain.root;
    const verb = args[0];

    if (!verb) {
      if (!cli.agentRunner) {
        throw new UsageError("`brain sync` (no verb) requires an agent runner. Try a mechanical verb: assess|group|pull|conflicts|push|post-sync.");
      }
      await runAgent(cli.agentRunner, "/sync", root);
      return;
    }

    const requireMain = (): number | null => {
      const branch = currentBranch(root);
      if (branch !== "main") {
        emit(cli.json, { error: `not on main branch (current: ${branch})`, branch }, () =>
          console.log(`ERROR: Not on main branch (current: ${branch})`)
        );
        return 1;
      }
      return null;
    };

    switch (verb) {
      case "assess": {
        const guard = requireMain();
        if (guard !== null) return guard;
        const files = assess(root);
        emit(cli.json, { branch: "main", files }, () => {
          console.log("# sync assess — file classification");
          for (const f of files) console.log(`${f.status}\t${f.class}\t${f.path}`);
          if (files.length === 0) console.log("# No local changes");
        });
        return 0;
      }

      case "group": {
        const guard = requireMain();
        if (guard !== null) return guard;
        const groups = assess(root)
          .filter((f) => f.class === "TRACK")
          .map((f) => ({ domain: domainFor(f.path, cli.brain.taxonomy), status: f.status, path: f.path }))
          .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path));
        emit(cli.json, { groups }, () => {
          console.log("# sync group — semantic domain grouping");
          for (const g of groups) console.log(`${g.domain}\t${g.status}\t${g.path}`);
        });
        return 0;
      }

      case "pull": {
        const fetch = git(root, ["fetch", "origin", "main"]);
        if (fetch.code !== 0) {
          emit(cli.json, { status: "fetch-failed" }, () => console.log("STATUS=fetch-failed"));
          return 1;
        }
        const localAhead = parseInt(git(root, ["rev-list", "--count", "origin/main..HEAD"]).stdout || "0", 10);
        const remoteAhead = parseInt(git(root, ["rev-list", "--count", "HEAD..origin/main"]).stdout || "0", 10);

        // A cache this clone's reindex rewrote blocks a merge that touches it,
        // and post-sync pushes caches, so the other clone's commit usually does.
        // Set it aside for the merge and union it back after.
        const aside = remoteAhead > 0 ? setDerivedCachesAside(root) : new Map<string, string>();
        const mergedCaches = [...aside.keys()];

        let status: string;
        let conflicts: string[] = [];
        if (remoteAhead === 0) {
          status = "synced";
        } else if (localAhead === 0) {
          status = git(root, ["merge", "--ff-only", "origin/main"]).code === 0 ? "fast-forwarded" : "merge-failed";
        } else if (git(root, ["merge", "origin/main", "--no-edit"]).code === 0) {
          status = "merged";
        } else {
          status = "conflicted";
          conflicts = git(root, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
        }

        unionDerivedCaches(root, aside);

        emit(cli.json, { status, localAhead, remoteAhead, conflicts, mergedCaches }, () => {
          console.log(`LOCAL_AHEAD=${localAhead}`);
          console.log(`REMOTE_AHEAD=${remoteAhead}`);
          console.log(`STATUS=${status}`);
          for (const c of conflicts) console.log(`CONFLICT=${c}`);
          for (const c of mergedCaches) console.log(`MERGED_CACHE=${c}`);
        });
        return status === "merge-failed" ? 1 : 0;
      }

      case "conflicts": {
        const paths = git(root, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
        const files = paths.map((file) => ({
          file,
          base: git(root, ["show", `:1:${file}`]).stdout || "(no base version)",
          ours: git(root, ["show", `:2:${file}`]).stdout || "(deleted on our side)",
          theirs: git(root, ["show", `:3:${file}`]).stdout || "(deleted on their side)",
        }));
        emit(cli.json, { files }, () => {
          for (const f of files) {
            console.log(`FILE=${f.file}`);
            console.log("───── BASE ─────");
            console.log(f.base);
            console.log("───── OURS ─────");
            console.log(f.ours);
            console.log("───── THEIRS ─────");
            console.log(f.theirs);
          }
        });
        return 0;
      }

      case "push": {
        const res = git(root, ["push", "origin", "main"]);
        const status = res.code === 0 ? "pushed" : "rejected";
        emit(cli.json, { status, detail: res.stderr || res.stdout }, () => console.log(`STATUS=${status}`));
        return status === "pushed" ? 0 : 1;
      }

      case "post-sync": {
        const result = await postSync(cli);
        emit(cli.json, result, () => {
          for (const [k, v] of Object.entries(result)) console.log(`${k}=${Array.isArray(v) ? v.join(",") : v}`);
        });
        return 0;
      }

      default:
        throw new UsageError(`Unknown sync verb: ${verb}. Use assess|group|pull|conflicts|push|post-sync.`);
    }
  },
};
