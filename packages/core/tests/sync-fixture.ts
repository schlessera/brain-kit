/**
 * Real repositories for the sync verb, run and scenario tests. Not a test
 * file itself (no `.test.ts`).
 *
 * A brain is the fixture corpus committed on `main` and pushed to a bare
 * remote; "another clone" is a plain git clone of that remote, standing in
 * for the brain on a second machine. Everything is Alex Example's.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { initContext } from "../src/lib/context";
import { mediaPolicy } from "../src/lib/media";
import { createSyncJudge, type JevLike, type SyncJudge } from "../src/lib/sync/judge";
import type { PostSyncResult, SyncEnv } from "../src/lib/sync/run";
import type { JevAnswers, JevChoiceQuestion, JevRequest } from "../src/lib/jev";
import { makeTempBrain, runCli } from "./cli-harness";

const dirs: string[] = [];

/** Remove every directory the fixtures made; call from `afterEach`. */
export function cleanupFixtures(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Git where failing is the point (a conflicting merge or pop). */
export function gitMayFail(cwd: string, ...args: string[]): number {
  return Bun.spawnSync(["git", "-C", cwd, ...args]).exitCode ?? 0;
}

export function identify(root: string): void {
  git(root, "config", "user.name", "Alex Example");
  git(root, "config", "user.email", "alex@example.test");
  git(root, "config", "commit.gpgsign", "false");
}

export function write(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** What a brain keeps out of git: the database and the materialized skills. */
const GITIGNORE = "brain.db\nbrain.db-*\nnode_modules\n.agents/skills/\n.claude/skills/\n";

/** A note both clones edit in the conflict scenarios; `notes/` merges keep-both. */
export const FIELD_NOTE = "health/trail-fitness.md";
export const FIELD_NOTE_TEXT = [
  "---",
  "title: Trail fitness",
  "type: health",
  "created: 2026-01-10",
  "updated: 2026-01-10",
  "---",
  "",
  "# Trail fitness",
  "",
  "## Routine",
  "",
  "Hike the ridge loop twice a week.",
  "",
  "## Gear",
  "",
  "Boots resoled in March.",
  "",
].join("\n");

export interface Brain {
  root: string;
  remote: string;
  base: string;
}

/** The fixture corpus plus FIELD_NOTE and a shell script, committed and pushed. */
export function brainWithRemote(): Brain {
  const root = makeTempBrain();
  const base = mkdtempSync(join(tmpdir(), "brain-sync-run-"));
  dirs.push(root, base);
  const remote = join(base, "remote.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
  git(root, "init", "-q", "-b", "main");
  identify(root);
  write(root, ".gitignore", GITIGNORE);
  write(root, FIELD_NOTE, FIELD_NOTE_TEXT);
  write(root, "scripts/backup.sh", "#!/bin/sh\necho backing up\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  return { root, remote, base };
}

/**
 * `ours` and `theirs` merged against `base` by `git merge-file` with
 * `size`-character conflict markers, as git writes them under a
 * `conflict-marker-size` attribute. Throws unless they conflict.
 */
export function mergeFileMarkers(base: string, ours: string, theirs: string, size: number): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-merge-file-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries({ base, ours, theirs })) writeFileSync(join(dir, name), text);
  const proc = Bun.spawnSync([
    "git", "merge-file", "-p", `--marker-size=${size}`, "-L", "HEAD", "-L", "base", "-L", "origin/main",
    join(dir, "ours"), join(dir, "base"), join(dir, "theirs"),
  ], { cwd: dir });
  // The exit code is the number of conflicts; a negative one (255 and up) is an error.
  if (!proc.exitCode || proc.exitCode > 127) throw new Error(`git merge-file did not conflict: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

/** A plain clone of the remote: the brain on another machine. */
export function otherClone(brain: Brain, name = "other"): string {
  const other = join(brain.base, name);
  Bun.spawnSync(["git", "clone", "-q", brain.remote, other]);
  identify(other);
  return other;
}

/** Commit `files` in `clone` (null deletes) and push. */
export function commitAndPush(clone: string, files: Record<string, string | null>, message: string): void {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) rmSync(join(clone, file), { force: true });
    else write(clone, file, text);
  }
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", message);
  git(clone, "push", "-q", "origin", "main");
}

export async function syncJson(root: string, ...args: string[]): Promise<{ code: number; body: any; stderr: string }> {
  const result = await runCli(root, ["sync", ...args, "--json"]);
  let body: unknown = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = result.stdout;
  }
  return { code: result.code, body, stderr: result.stderr };
}

type Answer = { choice: string; confidence: number };

/**
 * A fake Jev that answers every question through `oracle`, from the question
 * id (`f0.kind`, `p0.relation`, `p0r.relation`) and the state item it names,
 * and records each request. Never the network.
 */
export function fakeJev(oracle: (questionId: string, item: Record<string, string>) => Answer): JevLike & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    enabled: true,
    requests,
    async ask(request) {
      requests.push(request);
      const state = request.state as Record<string, Record<string, string>>;
      const answers: JevAnswers = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const key = id.slice(0, id.lastIndexOf("."));
        const { choice, confidence } = oracle(id, state[key]!);
        const options = Object.keys((question as JevChoiceQuestion).criteria);
        const probabilities = Object.fromEntries(
          options.map((o) => [o, o === choice ? confidence : (1 - confidence) / (options.length - 1)])
        );
        answers[id] = { type: "choice", choice, probabilities, confidence };
      }
      return { outcome: "answered", answers, durationMs: 1, model: "jev-test" };
    },
  };
}

/** A judge on a fake transport, or a disabled one. */
export function judgeWith(client: JevLike | null): SyncJudge {
  return client ? createSyncJudge({ apiKey: "test-key", client }) : createSyncJudge({ apiKey: null });
}

export const POST_SYNC_STUB: PostSyncResult = {
  skills: "stub",
  index: "stub",
  cacheCommit: "clean",
  treeDirty: [],
  branch: "main",
  localHead: "",
  remoteHead: "",
  sync: "complete",
  warnings: [],
};

/** A SyncEnv for `root` with the brain's real taxonomy, a given judge, and a post-sync that only counts its calls. */
export async function envFor(root: string, judge: SyncJudge, today = "2026-09-28"): Promise<SyncEnv & { postSyncCalls: number }> {
  const ctx = await initContext({ root });
  const env = {
    root,
    taxonomy: ctx.taxonomy,
    media: mediaPolicy(ctx.config),
    judge,
    today,
    postSyncCalls: 0,
    async postSync() {
      env.postSyncCalls++;
      return POST_SYNC_STUB;
    },
  };
  return env;
}

// ---------------------------------------------------------------------------
// E3 scenarios: the states a sync starts from. `sync-scenarios.test.ts`
// asserts what `run` makes of each; `scripts/measure-sync-run.ts` times them.
// ---------------------------------------------------------------------------

export const CACHE = ".context-cache.jsonl";
export const RIDGE_LINE = "Hike the ridge loop twice a week.";
export const OURS_RIDGE = "Hike the ridge loop with the dog, twice a week.";
export const THEIRS_RIDGE = "Hike the ridge loop at dawn, twice a week.";
const OWL_COUNT = "---\ntitle: Owl count\ntype: note\n---\n\nThree barred owls at the east meadow.\n";

/** A pre-push hook in `root` running `body` (git's own variables unset, so it can drive another clone). */
export function prePushHook(root: string, body: string): void {
  const hooks = join(root, ".git", "test-hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n${body}\n`);
  chmodSync(join(hooks, "pre-push"), 0o755);
  git(root, "config", "core.hooksPath", hooks);
}

export const SCENARIO_SETUPS = {
  /** (a) Nothing changed anywhere. */
  nothing(): void {},

  /** (b) Local edits only. */
  localOnly(brain: Brain): void {
    write(brain.root, "notes/owl-count.md", OWL_COUNT);
    write(brain.root, FIELD_NOTE, FIELD_NOTE_TEXT.replace("Boots resoled in March.", "Boots resoled in March; laces replaced."));
  },

  /** (c) Both clones edited, different files. */
  differentFiles(brain: Brain): void {
    commitAndPush(otherClone(brain), { "notes/elk-sighting.md": "---\ntitle: Elk sighting\ntype: note\n---\n\nA bull elk at the ford.\n" }, "theirs");
    write(brain.root, "notes/owl-count.md", OWL_COUNT);
  },

  /** (d) Both clones edited the same line of one note. */
  sameNote(brain: Brain): void {
    commitAndPush(otherClone(brain), { [FIELD_NOTE]: FIELD_NOTE_TEXT.replace(RIDGE_LINE, THEIRS_RIDGE) }, "theirs");
    write(brain.root, FIELD_NOTE, FIELD_NOTE_TEXT.replace(RIDGE_LINE, OURS_RIDGE));
  },

  /** (e) Both clones edited the same line of a script. */
  codeConflict(brain: Brain): void {
    commitAndPush(otherClone(brain), { "scripts/backup.sh": "#!/bin/sh\necho backing up to the station\n" }, "theirs");
    write(brain.root, "scripts/backup.sh", "#!/bin/sh\necho backing up to the cloud\n");
  },

  /** (f) The remote moves between this clone's pull and its push. */
  pushRace(brain: Brain): void {
    const other = otherClone(brain);
    write(brain.root, "notes/owl-count.md", OWL_COUNT);
    const mark = join(brain.base, "raced");
    prePushHook(brain.root, `if [ ! -f "${mark}" ]; then touch "${mark}"; cd "${other}" && git commit -q --allow-empty -m raced && git push -q origin main; fi\nexit 0`);
  },

  /**
   * (g) #328 S1: a merge left pending on a cache-only conflict, and the
   * remote moved on since.
   */
  pendingCacheMerge(brain: Brain): void {
    write(brain.root, CACHE, "");
    git(brain.root, "add", CACHE);
    git(brain.root, "commit", "-qm", "track the cache");
    git(brain.root, "push", "-q", "origin", "main");
    const other = otherClone(brain);
    commitAndPush(other, { [CACHE]: '{"k":"theirs","v":"from the other clone"}\n' }, "their cache");
    write(brain.root, CACHE, '{"k":"ours","v":"from this clone"}\n');
    git(brain.root, "commit", "-qam", "our cache");
    git(brain.root, "fetch", "-q", "origin");
    if (gitMayFail(brain.root, "merge", "origin/main", "--no-edit") === 0) throw new Error("the cache merge did not conflict");
    commitAndPush(other, { "notes/elk-sighting.md": "---\ntitle: Elk sighting\ntype: note\n---\n\nA bull elk at the ford.\n" }, "after the cache");
  },

  /** (h) A `git stash pop` that conflicted after a pull moved the note it stashed. */
  stashPopLeftover(brain: Brain): void {
    write(brain.root, FIELD_NOTE, FIELD_NOTE_TEXT.replace(RIDGE_LINE, OURS_RIDGE));
    git(brain.root, "stash", "-q");
    commitAndPush(otherClone(brain), { [FIELD_NOTE]: FIELD_NOTE_TEXT.replace(RIDGE_LINE, THEIRS_RIDGE) }, "theirs");
    git(brain.root, "pull", "-q", "--ff-only", "origin", "main");
    if (gitMayFail(brain.root, "stash", "pop") === 0) throw new Error("the stash pop did not conflict");
  },
} satisfies Record<string, (brain: Brain) => void>;
