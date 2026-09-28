import { openDatabase, migrateVecSchema, storedVectorWidth } from "../../lib/db.js";
import { indexAll } from "../../lib/indexer.js";
import { syncSkills } from "../../lib/skills/index.js";
import { mediaPolicy } from "../../lib/media.js";
import { resolveEnv } from "../../config/env.js";
import type { CoreCommand, CliContext } from "../types.js";
import { emit, embeddingDims, parseArgs, UsageError } from "../io.js";
import { runAgent } from "../agent.js";
import { resolveEmitters } from "../skills-util.js";
import { assess, classifyPostSyncDirt, domainFor, workingTreeDirt } from "../../lib/sync/assess.js";
import { currentBranch, git, unmergedPaths } from "../../lib/sync/git.js";
import { createSyncJudge, type SyncJudge } from "../../lib/sync/judge.js";
import { conclude } from "../../lib/sync/merge-state.js";
import { pull } from "../../lib/sync/pull.js";
import { planFromFile, serializePlan } from "../../lib/sync/commit.js";
import { reconcileStashes } from "../../lib/sync/stash.js";
import {
  assessFix,
  commitTracked,
  localDate,
  planTracked,
  resolveConflicts,
  runSync,
  type PostSyncResult,
  type RunEnvelope,
  type SyncEnv,
} from "../../lib/sync/run.js";
import { existsSync } from "fs";
import { resolve } from "path";

export { classifyPostSyncDirt, type DirtDisposition } from "../../lib/sync/assess.js";

const HELP = `brain sync [verb] — knowledge-aware brain synchronization

With no verb, runs the whole sync (\`run\`) and prints its report; then, when
an agent runner is configured, hands the agent (/sync skill) what the rules
could not settle: a conflict no strategy resolves, a file nothing could
classify, or media to ask about (interactive terminals only). For the
structured result use \`brain sync run --json\`.

  run          The whole sync: stash, assess --fix, commit, pull, resolve,
               conclude, push (re-pulling up to 3 times), post-sync.
               Exit 0 complete, 3 needs-judgment (nothing pushed), 1 failed
  assess       Classify local changes (SENSITIVE|ARTIFACT|DERIVED|TRACK|MEDIA|LARGE|UNKNOWN;
               MEDIA and LARGE carry their size in bytes)
    --fix      Also ignore ARTIFACT and SENSITIVE files in one .gitignore
               commit, and ask the judge about UNKNOWN files when it is on
  group        Group tracked changes by taxonomy domain
  commit       Commit TRACK files, one commit per domain, bumping \`updated\`
    --plan     Print the commit plan as JSON and change nothing
    --plan-file <path>  Apply an edited plan (messages as given, files checked)
  stash        Drop stash entries the tree already holds; pop a clean autostash
    --dry-run  Report what it would do
  pull         Fetch origin/main and fast-forward or merge, first finishing a
               merge left pending whose only conflicts are the derived caches
  resolve      Merge each conflicted file by its strategy (Jev judges passage
               pairs when TYPESAFE_API_KEY is set); leaves the rest for an agent
  conflicts    Emit BASE/OURS/THEIRS for each conflicted file
  conclude     Once nothing is unmerged, commit a pending merge or squash, or
               unstage what a conflicted stash pop left (its entry stays)
  push         Push to origin/main
  post-sync    Re-sync skills + reindex, commit the derived caches it rewrote,
               then report head parity and any remaining working-tree dirt`;

const VERBS = "run|assess|group|commit|stash|pull|resolve|conflicts|conclude|push|post-sync";

/** `assess` over the brain, a git failure as a usage error. */
function assessTree(cli: CliContext) {
  try {
    return assess(cli.brain.root, mediaPolicy(cli.brain.config));
  } catch (e) {
    throw new UsageError((e as Error).message);
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
  // Staging can leave nothing to commit: a staged change the reindex undid.
  if (git(root, ["diff", "--cached", "--quiet", "HEAD", "--", ...caches]).code === 0) return "clean";
  const committed = git(root, ["commit", "--only", "-m", "Refresh derived index caches", "--", ...caches]);
  if (committed.code !== 0) return `FAILED to commit — ${committed.stderr || committed.stdout}`;
  const pushed = git(root, ["push", "origin", "main"]);
  return pushed.code === 0
    ? `committed + pushed (${caches.join(", ")})`
    : `committed, push rejected — ${pushed.stderr || pushed.stdout}`;
}

async function postSync(cli: CliContext): Promise<PostSyncResult> {
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
  let sync: PostSyncResult["sync"];
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


/** The judge one sync holds: Jev with TYPESAFE_API_KEY unless `sync.judge` is "off". */
function syncJudge(cli: CliContext): SyncJudge {
  return createSyncJudge({ apiKey: resolveEnv().typesafeApiKey ?? null, mode: cli.brain.config?.sync?.judge });
}

function syncEnv(cli: CliContext, judge: SyncJudge = syncJudge(cli)): SyncEnv {
  return {
    root: cli.brain.root,
    taxonomy: cli.brain.taxonomy,
    media: mediaPolicy(cli.brain.config),
    judge,
    today: localDate(),
    postSync: () => postSync(cli),
  };
}

/** `KEY=value` lines for an object: arrays joined, nested objects as JSON. */
function printFields(result: object): void {
  for (const [k, v] of Object.entries(result)) {
    const text = Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(",") : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    console.log(`${k}=${text}`);
  }
}

const RUN_EXIT: Record<RunEnvelope["status"], number> = { complete: 0, "needs-judgment": 3, failed: 1 };

/**
 * Whether bare `brain sync` hands on to the agent after `run`: a conflict
 * blocked the push, a file nothing classified, or media, which only a person
 * at a terminal can be asked about.
 */
export function needsAgent(run: RunEnvelope, interactive: boolean): boolean {
  return (
    run.status === "needs-judgment" ||
    run.leftovers.unknown.length > 0 ||
    (run.leftovers.media.length > 0 && interactive)
  );
}

export const syncCommand: CoreCommand = {
  summary: "Sync the brain with its git remote (run the whole sync, or one verb of it)",
  helpBlock: HELP,
  async run(args, cli): Promise<number | void> {
    const root = cli.brain.root;
    // The argv remainder still carries the output-mode flags; the verb is the
    // first positional, so `brain sync --json assess` routes like `assess --json`.
    const { args: positional, flags } = parseArgs(args);
    const verb = positional[0];

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

    if (!verb) {
      // Always the report as text, never JSON: callers read it as the sync's
      // message (ui-server's BrainClient.sync), as they read the agent's
      // before. `brain sync run --json` is the structured form.
      const result = await runSync(syncEnv(cli));
      console.log(result.report);
      const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
      if (cli.agentRunner && needsAgent(result, interactive)) {
        await runAgent(cli.agentRunner, "/sync", root);
        return;
      }
      return RUN_EXIT[result.status];
    }

    switch (verb) {
      case "run": {
        const result = await runSync(syncEnv(cli));
        emit(cli.json, result, () => console.log(result.report));
        return RUN_EXIT[result.status];
      }

      case "assess": {
        const guard = requireMain();
        if (guard !== null) return guard;
        if (flags.fix === true) {
          const result = await assessFix(syncEnv(cli));
          emit(cli.json, result, () => {
            console.log("# sync assess --fix — file classification");
            for (const f of result.files) {
              console.log(`${f.status}\t${f.class}\t${f.path}${f.bytes === undefined ? "" : `\t${f.bytes}`}`);
            }
            printFields(result.fixed);
          });
          return result.fixed.committed?.status === "failed" ? 1 : 0;
        }
        const files = assessTree(cli);
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
        const groups = assessTree(cli)
          .filter((f) => f.class === "TRACK")
          .map((f) => ({ domain: domainFor(f.path, cli.brain.taxonomy), status: f.status, path: f.path }))
          .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path));
        emit(cli.json, { groups }, () => {
          console.log("# sync group — semantic domain grouping");
          for (const g of groups) console.log(`${g.domain}\t${g.status}\t${g.path}`);
        });
        return 0;
      }

      case "commit": {
        const guard = requireMain();
        if (guard !== null) return guard;
        const env = syncEnv(cli);
        const files = assessTree(cli);
        if (flags.plan === true) {
          const plan = planTracked(env, files);
          // The plan is JSON in both modes: it is meant to be edited and fed back.
          process.stdout.write(serializePlan(plan));
          return 0;
        }
        let plan;
        if (typeof flags["plan-file"] === "string") {
          const read = planFromFile(resolve(process.cwd(), flags["plan-file"]));
          if ("error" in read) throw new UsageError(`--plan-file: ${read.error}`);
          plan = read.plan;
        } else if (flags["plan-file"] !== undefined) {
          throw new UsageError("--plan-file needs a path");
        }
        const result = commitTracked(env, files, plan);
        emit(cli.json, result, () => {
          for (const c of result.commits) console.log("sha" in c ? `COMMIT=${c.sha} ${c.subject}` : `FAILED=${c.subject}: ${c.error}`);
          for (const b of result.bumped) console.log(`BUMPED=${b}`);
          for (const r of result.refused) console.log(`NOT_BUMPED=${r}`);
        });
        return result.commits.some((c) => "error" in c) ? 1 : 0;
      }

      case "stash": {
        const result = reconcileStashes(root, { dryRun: flags["dry-run"] === true });
        emit(cli.json, result, () => {
          for (const e of result.dropped) console.log(`DROPPED=${e.ref} ${e.reason}`);
          for (const e of result.popped) console.log(`POPPED=${e.ref}`);
          for (const e of result.kept) console.log(`KEPT=${e.ref} ${e.reason}`);
        });
        return 0;
      }

      case "pull": {
        const result = pull(root);
        const { status, localAhead, remoteAhead, conflicts, mergedCaches, concluded, reason } = result;
        emit(cli.json, status === "fetch-failed" ? { status, ...(reason ? { reason } : {}) } : result, () => {
          if (status === "fetch-failed") {
            console.log("STATUS=fetch-failed");
            return;
          }
          console.log(`LOCAL_AHEAD=${localAhead}`);
          console.log(`REMOTE_AHEAD=${remoteAhead}`);
          console.log(`STATUS=${status}`);
          if (concluded) console.log(`CONCLUDED=${concluded}`);
          if (reason !== undefined) console.log(`REASON=${reason}`);
          for (const c of conflicts) console.log(`CONFLICT=${c}`);
          for (const c of mergedCaches) console.log(`MERGED_CACHE=${c}`);
        });
        return status === "merge-failed" || status === "fetch-failed" ? 1 : 0;
      }

      case "resolve": {
        const result = await resolveConflicts(syncEnv(cli));
        emit(cli.json, result, () => {
          console.log(`STATUS=${result.status}`);
          for (const r of result.resolved) {
            console.log(`RESOLVED=${r.path}\t${r.strategy}`);
            for (const note of r.notes) console.log(`NOTE=${r.path}: ${note}`);
          }
          for (const u of result.unresolved) console.log(`UNRESOLVED=${u.path}\t${u.strategy}\t${u.reason}`);
          for (const s of result.skipped) console.log(`SKIPPED=${s.path}\t${s.reason}`);
        });
        return 0;
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
        emit(cli.json, result, () => printFields(result));
        return 0;
      }

      default:
        throw new UsageError(`Unknown sync verb: ${verb}. Use ${VERBS}.`);
    }
  },
};
