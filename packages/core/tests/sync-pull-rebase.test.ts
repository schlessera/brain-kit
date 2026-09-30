/** Rebase-first pulls against real clones; conflicts must return to merge semantics. */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brainConfigSchema } from "../src/lib/config";
import { runCli } from "./cli-harness";
import { brainWithRemote, cleanupFixtures, commitAndPush, git, gitMayFail, otherClone, write, type Brain } from "./sync-fixture";

afterEach(cleanupFixtures);
const CACHE = ".context-cache.jsonl";
const head = (root: string) => git(root, "rev-parse", "HEAD");

function commit(root: string, files: Record<string, string>, message = "local content"): void {
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "--", ...Object.keys(files));
  git(root, "commit", "-qm", message);
}

function divergent(shared = false): Brain {
  const brain = brainWithRemote();
  commit(brain.root, { [CACHE]: "", "notes/shared.md": "# Shared\n\nOriginal paragraph.\n" }, "shared baseline");
  git(brain.root, "push", "-q", "origin", "main");
  commitAndPush(otherClone(brain), shared ? { "notes/shared.md": "# Shared\n\nRemote paragraph.\n" } : { "notes/remote.md": "# Remote\n" }, "remote content");
  commit(brain.root, shared ? { "notes/shared.md": "# Shared\n\nLocal paragraph.\n" } : { "notes/local.md": "# Local\n" });
  return brain;
}

function expectNoRebase(root: string): void {
  for (const kind of ["rebase-merge", "rebase-apply"]) {
    expect(existsSync(git(root, "rev-parse", "--path-format=absolute", "--git-path", kind))).toBe(false);
  }
}

/** Record actual rebase invocations, even ones Git would refuse before running a hook. */
function recordingGit(root: string, refuseAbort = false): { env: Record<string, string>; calls(): string[] } {
  const bin = join(root, ".git", "test-bin");
  mkdirSync(bin);
  const log = join(bin, "rebase-calls");
  const executable = Bun.which("git")!;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const script = ["#!/bin/sh", 'for arg do', '  if [ "$arg" = rebase ]; then', `    printf '%s\\n' "$*" >> ${quote(log)}`, refuseAbort ? '    case " $* " in *" --abort "*) exit 1;; esac' : "", "    break", "  fi", "done", `exec ${quote(executable)} "$@"`, ""].join("\n");
  writeFileSync(join(bin, "git"), script);
  chmodSync(join(bin, "git"), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH}` }, calls: () => existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [] };
}

async function pull(root: string, env: Record<string, string> = {}) {
  const result = await runCli(root, ["sync", "pull", "--json"], env);
  return { result, body: JSON.parse(result.stdout) };
}

describe("rebase-first sync pull", () => {
  test("unpublished non-overlapping commits rebase into linear history by default", async () => {
    const { root } = divergent();
    const before = head(root);
    const { result, body } = await pull(root);
    expect(body.status).toBe("rebased");
    expect(result.code).toBe(0);
    expect(body.localAhead).toBe(1);
    expect(body.remoteAhead).toBe(1);
    expect(git(root, "log", "--merges", "--format=%H", "origin/main..HEAD")).toBe("");
    expect(gitMayFail(root, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe(0);
    expect(head(root)).not.toBe(before);
    expect(readFileSync(join(root, "notes/local.md"), "utf-8")).toBe("# Local\n");
    expect(readFileSync(join(root, "notes/remote.md"), "utf-8")).toBe("# Remote\n");
    expectNoRebase(root);
  });

  test("overlapping commits abort rebase before exposing local OURS and remote THEIRS merge stages", async () => {
    const { root } = divergent(true);
    const before = head(root);
    const recorder = recordingGit(root);
    const { result, body } = await pull(root, recorder.env);
    expect(git(root, "show", ":2:notes/shared.md")).toContain("Local paragraph.");
    expect(git(root, "show", ":3:notes/shared.md")).toContain("Remote paragraph.");
    expect(recorder.calls()).toHaveLength(2);
    expect(recorder.calls()[1]).toContain("rebase --abort");
    expect(body.status).toBe("conflicted");
    expect(body.conflicts).toEqual(["notes/shared.md"]);
    expect(result.code).toBe(0);
    expect(head(root)).toBe(before);
    expect(gitMayFail(root, "rev-parse", "--verify", "MERGE_HEAD")).toBe(0);
    expectNoRebase(root);
  });

  test("a local derived-cache change survives the aborted rebase byte-for-byte", async () => {
    const { root } = divergent(true);
    const ours = '{"k":"local-only","v":"local context"}\n';
    write(root, CACHE, ours);
    const recorder = recordingGit(root);
    const { body, result } = await pull(root, recorder.env);
    expect(readFileSync(join(root, CACHE), "utf-8")).toBe(ours);
    expect(recorder.calls().some((line) => line.includes("rebase --abort"))).toBe(true);
    expect(body.mergedCaches).toContain(CACHE);
    expect(body.status).toBe("conflicted");
    expect(result.code).toBe(0);
    expectNoRebase(root);
  });

  test("refused rebase and refused merge restore the cache index and working file separately", async () => {
    const { root } = divergent();
    // A dirty remote-touched file refuses both operations before they start.
    write(root, "notes/remote.md", "untracked local work\n");
    const staged = '{"k":"staged","v":"staged cache"}\n';
    const unstaged = '{"k":"unstaged","v":"working cache"}\n';
    write(root, CACHE, staged);
    git(root, "add", CACHE);
    write(root, CACHE, unstaged);
    const before = head(root);
    const { result, body } = await pull(root);
    expect(readFileSync(join(root, CACHE), "utf-8")).toBe(unstaged);
    expect(git(root, "show", `:${CACHE}`)).toBe(staged.trim());
    expect(body.status).toBe("merge-failed");
    expect(result.code).toBe(1);
    expect(head(root)).toBe(before);
    expect(readFileSync(join(root, "notes/remote.md"), "utf-8")).toBe("untracked local work\n");
    expectNoRebase(root);
  });

  test("a rebase refused by its hook falls back to a clean merge", async () => {
    const { root } = divergent();
    const hook = join(root, ".git", "hooks", "pre-rebase");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const { result, body } = await pull(root);
    expect(body.status).toBe("merged");
    expect(result.code).toBe(0);
    expect(git(root, "log", "--merges", "--format=%H", "origin/main..HEAD").split("\n")).toHaveLength(1);
    expectNoRebase(root);
  });

  test("an unsuccessful abort leaves rebase state for its owner and refuses the merge fallback", async () => {
    const { root } = divergent(true);
    const recorder = recordingGit(root, true);
    const { result, body } = await pull(root, recorder.env);
    expect(body.reason ?? "").toContain("could not abort rebase");
    expect(body.status).toBe("merge-failed");
    expect(result.code).toBe(1);
    expect(existsSync(join(root, ".git", "rebase-merge"))).toBe(true);
    expect(gitMayFail(root, "rev-parse", "--verify", "MERGE_HEAD")).not.toBe(0);
    // Test-owned operation: clean up through the real Git, outside the refusal wrapper.
    git(root, "rebase", "--abort");
  });

  for (const state of ["merge", "rebase-merge", "rebase-apply", "unmerged"]) {
    test(`never attempts a rebase while ${state} is already pending`, async () => {
      const { root } = divergent(true);
      git(root, "fetch", "-q", "origin", "main");
      if (state === "merge" || state === "unmerged") {
        expect(gitMayFail(root, "merge", "origin/main", "--no-edit")).not.toBe(0);
        if (state === "unmerged") rmSync(join(root, ".git", "MERGE_HEAD"));
      } else {
        expect(gitMayFail(root, "rebase", ...(state === "rebase-apply" ? ["--apply"] : []), "origin/main")).not.toBe(0);
        expect(existsSync(join(root, ".git", state))).toBe(true);
      }
      const before = head(root);
      const index = git(root, "ls-files", "-s");
      const recorder = recordingGit(root);
      const { result, body } = await pull(root, recorder.env);
      expect(recorder.calls()).toEqual([]);
      expect(head(root)).toBe(before);
      expect(git(root, "ls-files", "-s")).toBe(index);
      expect(body.status).toBe(state.startsWith("rebase") ? "merge-failed" : "conflicted");
      expect(result.code).toBe(state.startsWith("rebase") ? 1 : 0);
    });
  }

  for (const [hooked, locallyDirty] of [[false, true], [true, true], [true, false]] as const) {
    test(`clean rebase unions local and fetched caches (reindex hook=${hooked}, local cache=${locallyDirty})`, async () => {
      const brain = brainWithRemote();
      commit(brain.root, { [CACHE]: "" });
      git(brain.root, "push", "-q", "origin", "main");
      const theirs = '{"k":"remote","v":"remote context"}\n';
      commitAndPush(otherClone(brain), { [CACHE]: theirs }, "remote cache");
      commit(brain.root, { "notes/local.md": "# Local\n" });
      const ours = '{"k":"local","v":"local context"}\n';
      if (locallyDirty) write(brain.root, CACHE, ours);
      if (hooked) {
        const hook = join(brain.root, ".git", "hooks", "post-checkout");
        writeFileSync(hook, `#!/bin/sh\nprintf 'pruned\\n' > "${CACHE}"\n`);
        chmodSync(hook, 0o755);
      }
      const { result, body } = await pull(brain.root);
      expect(body.status).toBe("rebased");
      expect(readFileSync(join(brain.root, CACHE), "utf-8")).toBe((locallyDirty ? ours : "") + theirs);
      expect(body.mergedCaches).toEqual([CACHE]);
      expect(result.code).toBe(0);
    });
  }

  test("rebase keeps history linear when Git config requests preserving local merges", async () => {
    const { root } = divergent();
    git(root, "switch", "-q", "-c", "local-topic");
    commit(root, { "notes/topic.md": "# Topic\n" }, "topic content");
    git(root, "switch", "-q", "main");
    git(root, "merge", "--no-ff", "--no-edit", "local-topic");
    git(root, "config", "rebase.rebaseMerges", "true");
    const { result, body } = await pull(root);
    expect(git(root, "log", "--merges", "--format=%H", "origin/main..HEAD")).toBe("");
    expect(body.status).toBe("rebased");
    expect(result.code).toBe(0);
    for (const file of ["local", "remote", "topic"]) expect(readFileSync(join(root, `notes/${file}.md`), "utf-8")).toContain("# ");
  });

  test("rebase never autostashes unrelated dirty work even when configured", async () => {
    const { root } = divergent();
    git(root, "config", "rebase.autoStash", "true");
    const dirty = "# Shared\n\nUncommitted work.\n";
    write(root, "notes/shared.md", dirty);
    const { result, body } = await pull(root);
    expect(body.status).toBe("merged");
    expect(readFileSync(join(root, "notes/shared.md"), "utf-8")).toBe(dirty);
    expect(git(root, "stash", "list")).toBe("");
    expect(result.code).toBe(0);
  });

  test("rebase leaves other local branch refs untouched even when updateRefs is enabled", async () => {
    const { root } = divergent();
    const before = head(root);
    git(root, "branch", "retained", before);
    git(root, "config", "rebase.updateRefs", "true");
    const { result, body } = await pull(root);
    expect(git(root, "rev-parse", "retained")).toBe(before);
    expect(head(root)).not.toBe(before);
    expect(body.status).toBe("rebased");
    expect(result.code).toBe(0);
  });

  test("a sync-owned cache merge concludes before the next divergent rebase starts", async () => {
    const brain = brainWithRemote();
    commit(brain.root, { [CACHE]: '{"k":"key","v":"base"}\n' });
    git(brain.root, "push", "-q", "origin", "main");
    const other = otherClone(brain);
    commitAndPush(other, { [CACHE]: '{"k":"key","v":"remote"}\n' }, "remote cache");
    commit(brain.root, { [CACHE]: '{"k":"key","v":"local"}\n' });
    git(brain.root, "fetch", "-q", "origin", "main");
    expect(gitMayFail(brain.root, "merge", "origin/main", "--no-edit")).not.toBe(0);
    commitAndPush(other, { "notes/later.md": "# Later\n" }, "remote moves again");
    const hook = join(brain.root, ".git", "hooks", "pre-rebase");
    const ready = join(brain.root, ".git", "ready-for-rebase");
    writeFileSync(hook, '#!/bin/sh\ntest ! -f .git/MERGE_HEAD || exit 9\ntest -z "$(git ls-files --unmerged)" || exit 9\nprintf ready > .git/ready-for-rebase\n');
    chmodSync(hook, 0o755);
    const { result, body } = await pull(brain.root);
    expect(existsSync(ready)).toBe(true);
    expect(body.concluded).toBe("merge");
    expect(body.conflicts).toEqual([]);
    expect(gitMayFail(brain.root, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe(0);
    expect(result.code).toBe(0);
    expectNoRebase(brain.root);
  });

  for (const verb of ["pull", "run"]) {
    for (const strategy of ["rebase", "merge"] as const) {
      test(`sync ${verb} consumes configured sync.pull=${strategy}`, async () => {
        const brain = brainWithRemote();
        write(brain.root, "brain.config.ts", `export default { sync: { pull: "${strategy}", judge: "off" } };\n`);
        git(brain.root, "add", "brain.config.ts");
        git(brain.root, "commit", "-qm", "configure sync");
        git(brain.root, "push", "-q", "origin", "main");
        commitAndPush(otherClone(brain), { "notes/remote.md": "# Remote\n" }, "remote content");
        commit(brain.root, { "notes/local.md": "# Local\n" });
        const result = await runCli(brain.root, ["sync", verb, "--json"]);
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(verb === "pull" ? body.status : body.steps.pull[0].status).toBe(strategy === "rebase" ? "rebased" : "merged");
        const merges = git(brain.root, "log", "--merges", "--format=%H");
        expect(merges ? merges.split("\n").length : 0).toBe(strategy === "merge" ? 1 : 0);
        expect(gitMayFail(brain.root, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe(0);
        if (verb === "run") expect(git(brain.remote, "rev-parse", "main")).toBe(head(brain.root));
      });
    }
  }

  test("sync.pull accepts only the two strategies and composes with sync.judge", () => {
    for (const strategy of ["rebase", "merge"] as const) {
      const parsed = brainConfigSchema.safeParse({ sync: { pull: strategy, judge: "off" } });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.sync).toEqual({ pull: strategy, judge: "off" });
    }
    for (const pull of [true, "squash", null, 0]) expect(brainConfigSchema.safeParse({ sync: { pull } }).success).toBe(false);
    expect(brainConfigSchema.safeParse({ sync: {} }).success).toBe(true);
  });
});
