import { openDatabase, migrateVecSchema, storedVectorWidth } from "../../lib/db.js";
import { indexAll } from "../../lib/indexer.js";
import { syncSkills } from "../../lib/skills/index.js";
import { matchesAnyPattern, TOOL_LEFTOVER_PATTERNS } from "../../lib/tool-leftovers.js";
import { isMediaPath, mediaPolicy, mediaPolicyClass, type MediaPolicy } from "../../lib/media.js";
import type { Taxonomy } from "../../lib/taxonomy.js";
import type { CoreCommand, CliContext } from "../types.js";
import { emit, embeddingDims, parseArgs, UsageError } from "../io.js";
import { runAgent } from "../agent.js";
import { resolveEmitters } from "../skills-util.js";
import { currentBranch, git, isAncestor, unmergedPaths } from "../../lib/sync/git.js";
import { conclude, pendingState, rememberStash, type PendingKind } from "../../lib/sync/merge-state.js";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const HELP = `brain sync [verb] — knowledge-aware brain synchronization

With no verb, delegates the full workflow to the coding agent (/sync skill).
Mechanical verbs (structured output for the skill to drive):

  assess       Classify local changes (SENSITIVE|ARTIFACT|DERIVED|TRACK|MEDIA|LARGE|UNKNOWN;
               MEDIA and LARGE carry their size in bytes)
  group        Group tracked changes by taxonomy domain
  pull         Fetch origin/main and fast-forward or merge, first finishing a
               merge left pending whose only conflicts are the derived caches
  conflicts    Emit BASE/OURS/THEIRS for each conflicted file
  conclude     Once nothing is unmerged, commit a pending merge or squash, or
               unstage what a conflicted stash pop left (its entry stays)
  push         Push to origin/main
  post-sync    Re-sync skills + reindex, commit the derived caches it rewrote,
               then report head parity and any remaining working-tree dirt`;

// Artifact + sensitive path globs (ported from sync.sh). No personal patterns.
// The tool leftovers are shared with brain doctor and the template .gitignore.
const ARTIFACT_PATTERNS = [
  ...TOOL_LEFTOVER_PATTERNS,
  // No office formats: a presentation is media, and the MEDIA/LARGE classes
  // (with `media.ignore` for generated ones) decide it.
  "*.pyc", "__pycache__/*", "*.db-shm", "*.db-wal", "tmp/*", "*.log",
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

interface AssessedFile {
  status: string;
  class: "SENSITIVE" | "ARTIFACT" | "DERIVED" | "TRACK" | "MEDIA" | "LARGE" | "UNKNOWN";
  path: string;
  /** Size on disk, for MEDIA and LARGE only. */
  bytes?: number;
}

/**
 * Size of `file` under `root` as git would store it: a regular file's bytes,
 * or null for a deletion or a symlink (git stores the link, not its target).
 * "unreadable" when the size could not be read, which is never a reason to
 * treat a file as small.
 */
function sizeOf(root: string, file: string): number | null | "unreadable" {
  try {
    const stat = lstatSync(resolve(root, file));
    return stat.isFile() ? stat.size : null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
}

/**
 * Classes, first match wins:
 * - SENSITIVE: a secret-shaped name, whatever the media policy says.
 * - `media.ignore` → ARTIFACT, `media.track` → TRACK.
 * - ARTIFACT: tool leftovers and generated output.
 * - DERIVED: the sidecar caches.
 * - LARGE: anything over `media.maxTrackedBytes`. An ARTIFACT or DERIVED
 *   match wins over it: those are never committed, whatever their size.
 * - MEDIA: an image, PDF, audio, video or office file.
 * - UNKNOWN when the size could not be read; otherwise TRACK for text, or UNKNOWN.
 */
function assess(root: string, media: MediaPolicy): AssessedFile[] {
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
    let bytes: number | null = null;
    let size: number | null | "unreadable" = null;
    const policy = mediaPolicyClass(file, media);
    if (matchesAnyPattern(file, SENSITIVE_PATTERNS)) klass = "SENSITIVE";
    else if (policy) klass = policy;
    else if (matchesAnyPattern(file, ARTIFACT_PATTERNS)) klass = "ARTIFACT";
    // Committed on purpose, but post-sync commits them after its reindex —
    // taking them here too would just commit a stale copy and duplicate work.
    else if (DERIVED_CACHES.has(file)) klass = "DERIVED";
    else if ((size = sizeOf(root, file)) === "unreadable") klass = "UNKNOWN";
    else if ((bytes = size) !== null && bytes > media.maxTrackedBytes) klass = "LARGE";
    else if (bytes !== null && isMediaPath(file)) klass = "MEDIA";
    else if (isTrackable(file)) klass = "TRACK";
    else klass = "UNKNOWN";

    files.push(
      klass === "MEDIA" || klass === "LARGE" ? { status, class: klass, path: file, bytes: bytes! } : { status, class: klass, path: file }
    );
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

/** A cache as this clone had it: the file (null when gone) and its index entry (`ls-files -s`). */
interface CacheAside {
  file: string | null;
  index: string;
}

/**
 * Set local changes to the derived caches aside so a merge can touch them.
 * Hooks off: restoring a file fires post-checkout, whose reindex can rewrite
 * it right back.
 */
function setDerivedCachesAside(root: string): Map<string, CacheAside> {
  const aside = new Map<string, CacheAside>();
  for (const file of classifyPostSyncDirt(workingTreeDirt(root)).caches) {
    const path = resolve(root, file);
    aside.set(file, {
      file: existsSync(path) ? readFileSync(path, "utf-8") : null,
      index: git(root, ["ls-files", "-s", "--", file]).stdout,
    });
    if (git(root, ["cat-file", "-e", `HEAD:${file}`]).code === 0) {
      git(root, ["-c", "core.hooksPath=/dev/null", "restore", "--source=HEAD", "--staged", "--worktree", "--", file]);
    } else {
      git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", file]);
      rmSync(path, { force: true });
    }
  }
  return aside;
}

/** Put the caches back exactly as they were, index and file, for when no merge happened. */
function putDerivedCachesBack(root: string, aside: Map<string, CacheAside>): void {
  for (const [file, saved] of aside) {
    const entry = /^(\d+) ([0-9a-f]+) 0\t/.exec(saved.index);
    if (entry) git(root, ["update-index", "--add", "--cacheinfo", `${entry[1]},${entry[2]},${file}`]);
    else git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", file]);
    const path = resolve(root, file);
    if (saved.file === null) rmSync(path, { force: true });
    else writeFileSync(path, saved.file, "utf-8");
  }
}

/**
 * Union each cache's entries into one sorted file: what this clone set aside,
 * and the merge's result. A key both carry keeps its first line in sorted
 * order, the rule every sidecar reader applies, so two clones that generated
 * different text for one key settle on the same line instead of each keeping
 * its own and committing it back on every sync. For a conflicted cache
 * the result is read from the two sides' index stages, not the working file,
 * whose conflict rendering can carry the ancestor's stale lines (diff3). An
 * entry only this clone has may belong to a chunk the merge re-chunks, and the
 * reindex can recover it only from the file.
 */
function unionDerivedCaches(
  root: string,
  files: Iterable<string>,
  aside: Map<string, CacheAside>,
  conflicted: ReadonlySet<string>
): void {
  for (const file of files) {
    const path = resolve(root, file);
    const sources = [aside.get(file)?.file ?? ""];
    if (conflicted.has(file)) {
      for (const stage of [2, 3]) sources.push(git(root, ["show", `:${stage}:${file}`], true).stdout);
    } else if (existsSync(path)) {
      sources.push(readFileSync(path, "utf-8"));
    }
    const byKey = new Map<string, string>();
    const all = sources.join("\n").split("\n").filter((line) => line.trim());
    all.sort();
    for (const line of all) {
      // Only a line a reader would accept may compete for its key. A line
      // with no string value can sort first and would win, then every
      // reader rejects it and the key is lost.
      try {
        const { k, v } = JSON.parse(line) as { k?: unknown; v?: unknown };
        if (typeof k === "string" && k && typeof v === "string" && !byKey.has(k)) byKey.set(k, line);
      } catch {
        // skip malformed line
      }
    }
    const lines = [...byKey.values()]; // already in sorted order
    writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
  }
}

/** What one pass of `pull` left, in the shape `pull` reports. */
interface PullPass {
  status: string;
  conflicts: string[];
  mergedCaches: string[];
  reason?: string;
}

/** The statuses that claim origin/main is in HEAD. */
const INTEGRATED = new Set(["synced", "fast-forwarded", "merged"]);

function countCommits(root: string, range: string): number {
  return parseInt(git(root, ["rev-list", "--count", range]).stdout || "0", 10);
}

/**
 * Bring origin/main into HEAD once: synced when it is there already, else a
 * fast-forward or a merge. The counts are taken afresh on each pass, because
 * concluding a pending merge before it moves HEAD.
 */
function mergeOriginMain(root: string): PullPass {
  const localAhead = countCommits(root, "origin/main..HEAD");
  const remoteAhead = countCommits(root, "HEAD..origin/main");

  // A cache this clone's reindex rewrote blocks a merge that touches it,
  // and post-sync pushes caches, so the other clone's commit usually does.
  // Set it aside for the merge and union it back after.
  // A merge already in progress owns the caches' index stages; setting
  // them aside would erase a cache conflict before it is resolved. A
  // squash merge leaves its stages without a MERGE_HEAD.
  const alreadyMerging =
    git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0 ||
    git(root, ["ls-files", "--unmerged"]).stdout !== "";
  const aside =
    remoteAhead > 0 && !alreadyMerging ? setDerivedCachesAside(root) : new Map<string, CacheAside>();

  let status: string;
  let conflicts: string[] = [];
  let reason: string | undefined;
  if (remoteAhead === 0) {
    status = "synced";
  } else if (localAhead === 0) {
    status = git(root, ["merge", "--ff-only", "origin/main"]).code === 0 ? "fast-forwarded" : "merge-failed";
  } else if (git(root, ["merge", "origin/main", "--no-edit"]).code === 0) {
    status = "merged";
  } else {
    // Classify on what the failed merge left in the index, not on
    // MERGE_HEAD: a squash merge (branch.main.mergeOptions) stops on
    // conflicts without one, and a merge left unfinished before this pull
    // keeps one with nothing to resolve. Unmerged paths are Phase 4's
    // work; none means git refused, which is only to report.
    conflicts = unmergedPaths(root);
    status = conflicts.length > 0 ? "conflicted" : "merge-failed";
  }

  // No merge started (git refused before touching the tree): put the
  // caches back as they were. Otherwise union them, which also resolves
  // a cache conflict, so Phase 4 never sees one.
  const merging =
    conflicts.length > 0 || git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0;
  const cacheConflicts = conflicts.filter((file) => DERIVED_CACHES.has(file));
  const mergedCaches = [...new Set([...aside.keys(), ...cacheConflicts])];
  if (status === "fast-forwarded" || status === "merged" || merging) {
    unionDerivedCaches(root, mergedCaches, aside, new Set(cacheConflicts));
    if (cacheConflicts.length > 0) {
      git(root, ["add", "--", ...cacheConflicts]);
      conflicts = conflicts.filter((file) => !DERIVED_CACHES.has(file));
      if (conflicts.length === 0) {
        const done = conclude(root);
        status = done.outcome === "committed" ? "merged" : "merge-failed";
        reason = done.detail;
      }
    }
  } else {
    putDerivedCachesBack(root, aside);
  }
  return reason === undefined ? { status, conflicts, mergedCaches } : { status, conflicts, mergedCaches, reason };
}

/**
 * `pull` after its fetch. Merge state already pending when it runs is dealt
 * with first (#328): a rebase, cherry-pick, revert or am is never touched,
 * nor is a merge or squash with nothing unmerged, which is its owner's to
 * commit; unmerged derived caches are unioned from their stages, as in a merge this
 * pull starts; any other unmerged path is reported for resolution before a
 * merge is tried, since git would refuse one over it. With nothing left
 * unmerged the pending state is finished by its kind (`conclude`).
 *
 * A status in INTEGRATED claims origin/main is in HEAD, and must be true. A
 * pass can leave it out (a squash merge never records it as a parent), so a
 * pass that does gets one more, and after that the pull is merge-failed.
 */
function pullOriginMain(root: string): { pass: PullPass; concluded: PendingKind | null } {
  const pending = pendingState(root);
  if (pending.kind === "blocked") {
    const reason = `a ${pending.blocker} is in progress`;
    return { pass: { status: "merge-failed", conflicts: [], mergedCaches: [], reason }, concluded: null };
  }

  // A merge or squash with nothing unmerged is its owner's to commit (a
  // `--no-commit` merge, or a squash git stopped before committing). A merge
  // over it is refused, and a refused squash merge deletes SQUASH_MSG, which
  // turns the squash into staged work nothing tells from anyone else's.
  if ((pending.kind === "merge" || pending.kind === "squash") && pending.unmerged.length === 0) {
    const reason = `a ${pending.kind} is pending with nothing unmerged; finish it with \`brain sync conclude\``;
    return { pass: { status: "merge-failed", conflicts: [], mergedCaches: [], reason }, concluded: null };
  }

  const resolvedCaches = pending.unmerged.filter((file) => DERIVED_CACHES.has(file));
  let concluded: PendingKind | null = null;
  let committed = false;
  // A stash leftover resolved since it was remembered has nothing unmerged
  // and is still unstaged here.
  if (pending.unmerged.length > 0 || pending.kind === "stash") {
    unionDerivedCaches(root, resolvedCaches, new Map(), new Set(resolvedCaches));
    if (resolvedCaches.length > 0) git(root, ["add", "--", ...resolvedCaches]);
    const conflicts = pending.unmerged.filter((file) => !DERIVED_CACHES.has(file));
    if (conflicts.length > 0) {
      rememberStash(root, pending);
      return { pass: { status: "conflicted", conflicts, mergedCaches: resolvedCaches }, concluded: null };
    }
    const done = conclude(root, pending);
    if (done.outcome !== "committed" && done.outcome !== "unstaged") {
      const reason = done.detail ?? done.outcome;
      return { pass: { status: "merge-failed", conflicts: [], mergedCaches: resolvedCaches, reason }, concluded: null };
    }
    concluded = pending.kind;
    committed = done.outcome === "committed";
  }

  let pass = mergeOriginMain(root);
  if (INTEGRATED.has(pass.status) && !isAncestor(root, "origin/main", "HEAD")) {
    // A pass that left state pending (a squash merge git did not commit)
    // would only be refused by a second merge.
    if (pendingState(root).kind === "none") {
      const again = mergeOriginMain(root);
      pass = { ...again, mergedCaches: [...new Set([...pass.mergedCaches, ...again.mergedCaches])] };
    }
    if (INTEGRATED.has(pass.status) && !isAncestor(root, "origin/main", "HEAD")) {
      pass = { ...pass, status: "merge-failed", reason: "origin/main is not in HEAD" };
    }
  }
  // Nothing new to fetch, but the pull did finish a merge.
  if (committed && pass.status === "synced") pass = { ...pass, status: "merged" };
  return { pass: { ...pass, mergedCaches: [...new Set([...resolvedCaches, ...pass.mergedCaches])] }, concluded };
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
  // Staging can leave nothing to commit: a staged change the reindex undid.
  if (git(root, ["diff", "--cached", "--quiet", "HEAD", "--", ...caches]).code === 0) return "clean";
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
    // The argv remainder still carries the output-mode flags; the verb is the
    // first positional, so `brain sync --json assess` routes like `assess --json`.
    const verb = parseArgs(args).args[0];

    if (!verb) {
      if (!cli.agentRunner) {
        throw new UsageError("`brain sync` (no verb) requires an agent runner. Try a mechanical verb: assess|group|pull|conflicts|conclude|push|post-sync.");
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
        const files = assess(root, mediaPolicy(cli.brain.config));
        emit(cli.json, { branch: "main", files }, () => {
          console.log("# sync assess — file classification");
          for (const f of files) {
            console.log(`${f.status}\t${f.class}\t${f.path}${f.bytes === undefined ? "" : `\t${f.bytes}`}`);
          }
          if (files.length === 0) console.log("# No local changes");
        });
        return 0;
      }

      case "group": {
        const guard = requireMain();
        if (guard !== null) return guard;
        const groups = assess(root, mediaPolicy(cli.brain.config))
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
        // Measured before anything below moves HEAD.
        const localAhead = countCommits(root, "origin/main..HEAD");
        const remoteAhead = countCommits(root, "HEAD..origin/main");
        const { pass, concluded } = pullOriginMain(root);
        const { status, conflicts, mergedCaches, reason } = pass;

        emit(
          cli.json,
          { status, localAhead, remoteAhead, conflicts, mergedCaches, concluded, ...(reason === undefined ? {} : { reason }) },
          () => {
            console.log(`LOCAL_AHEAD=${localAhead}`);
            console.log(`REMOTE_AHEAD=${remoteAhead}`);
            console.log(`STATUS=${status}`);
            if (concluded) console.log(`CONCLUDED=${concluded}`);
            if (reason !== undefined) console.log(`REASON=${reason}`);
            for (const c of conflicts) console.log(`CONFLICT=${c}`);
            for (const c of mergedCaches) console.log(`MERGED_CACHE=${c}`);
          }
        );
        return status === "merge-failed" ? 1 : 0;
      }

      case "conflicts": {
        const paths = unmergedPaths(root);
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

      case "conclude": {
        const done = conclude(root);
        emit(cli.json, done, () => {
          console.log(`OUTCOME=${done.outcome}`);
          console.log(`KIND=${done.kind}`);
          if (done.detail !== undefined) console.log(`DETAIL=${done.detail}`);
        });
        return done.outcome === "committed" || done.outcome === "unstaged" || done.outcome === "nothing" ? 0 : 1;
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
        throw new UsageError(`Unknown sync verb: ${verb}. Use assess|group|pull|conflicts|conclude|push|post-sync.`);
    }
  },
};
