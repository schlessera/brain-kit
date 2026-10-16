import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateCandidate } from "../scripts/candidate-proof";
import type { API } from "../scripts/proof-reuse";
import { nativeRequestBody, ownNativeParent, verifyNativePrefix, type NativePrefix } from "../scripts/native-candidate";
import { changedFiles, judge } from "../scripts/check-contract-pr";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-candidate-")); dirs.push(root);
  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: {
      ...process.env, GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid",
      GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid",
    } });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  }
  git("init", "-q");
  writeFileSync(join(root, "README.md"), "Odysseus sails.\n"); git("add", ".");
  const trunk = git("commit-tree", git("write-tree"), "-m", "trunk");
  mkdirSync(join(root, "docs")); writeFileSync(join(root, "docs/integration-contract.md"), "The crossing contract.\n"); git("add", ".");
  const lower = git("commit-tree", git("write-tree"), "-p", trunk, "-m", "lower");
  const synthetic = git("commit-tree", git("write-tree"), "-p", trunk, "-p", lower, "-m", "lower candidate");
  writeFileSync(join(root, "raft.md"), "The raft manifest.\n"); git("add", ".");
  const upper = git("commit-tree", git("write-tree"), "-p", lower, "-m", "upper");
  const sha = git("commit-tree", git("write-tree"), "-p", synthetic, "-p", upper, "-m", "upper candidate");
  git("update-ref", "HEAD", sha);
  const actual = { sha, tree: git("rev-parse", `${sha}^{tree}`), parents: [synthetic, upper] };
  const prefix: NativePrefix = { version: 1, request: "1".repeat(32), repository: "fixture/brain-kit", pr: 2, stack: 7, position: 2,
    trunk: { ref: "main", sha: trunk }, members: [
      { number: 1, ref: "lower", head: lower, parent: "main" },
      { number: 2, ref: "upper", head: upper, parent: "lower" },
    ] };
  const body = `Native request\n<!-- brain-native-candidate: ${Buffer.from(JSON.stringify(prefix)).toString("base64url")} -->`;
  const stack = { number: 7, position: 2, size: 2, base: { ref: "main", sha: trunk } };
  const event = { action: "ready_for_review", pull_request: { number: 2, draft: false, body,
    head: { sha: upper }, base: { ref: "main", sha: trunk }, stack } };
  const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: sha, GITHUB_REPOSITORY: "fixture/brain-kit" };
  const replies: Record<string, any> = {
    "stacks/7": { number: 7, base: { ref: "main" }, pull_requests: [{ number: 1, state: "open" }, { number: 2, state: "open" }] },
    "pulls/1": { number: 1, state: "open", draft: false, head: { ref: "lower", sha: lower, repo: { full_name: env.GITHUB_REPOSITORY } }, base: { ref: "main", sha: trunk, repo: { full_name: env.GITHUB_REPOSITORY } }, stack: { ...stack, position: 1 } },
    "pulls/2": { number: 2, state: "open", draft: false, body, head: { ref: "upper", sha: upper, repo: { full_name: env.GITHUB_REPOSITORY } }, base: { ref: "lower", sha: lower, repo: { full_name: env.GITHUB_REPOSITORY } }, stack: structuredClone(stack) },
    "git/ref/heads/main": { object: { sha: trunk } }, "git/ref/heads/lower": { object: { sha: lower } }, "git/ref/heads/upper": { object: { sha: upper } },
  };
  for (const id of [sha, synthetic]) {
    const [commit, tree, ...parents] = git("show", "-s", "--format=%H %T %P", id).split(" ");
    replies[`git/commits/${id}`] = { sha: commit, tree: { sha: tree }, parents: parents.map(sha => ({ sha })) };
  }
  const api: API = { async json(path) { if (!(path in replies)) throw new Error(`Missing fixture API ${path}`); return structuredClone(replies[path]); }, async log() { throw new Error("Unexpected log"); } };
  return { root, git, event, env, actual, prefix, replies, api };
}

test("native candidate accepts the verified ordered synthetic chain rather than the declared branch tip", async () => {
  const f = fixture();
  await validateCandidate(f.root, f.event, f.env, f.api, f.actual);
});

test("strictly higher-layer changes do not change the frozen contributing prefix", async () => {
  const f = fixture();
  f.replies["stacks/7"].pull_requests.push({ number: 3, state: "open" });
  f.replies["pulls/2"].stack.size = 3;
  await validateCandidate(f.root, f.event, f.env, f.api, f.actual);
});

test("native proof rejects stale or missing request, membership, refs, readiness and immutable evidence", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.event.pull_request.body = "missing request"; },
    f => { f.event.pull_request.stack.position = 1; },
    f => { f.event.pull_request.base.sha = "a".repeat(40); },
    f => { f.replies["stacks/7"].pull_requests.reverse(); },
    f => { f.replies["stacks/7"].pull_requests.shift(); },
    f => { f.replies["stacks/7"].pull_requests[0].number = 99; },
    f => { f.replies["pulls/1"].draft = true; },
    f => { f.replies["pulls/1"].base.ref = "other"; },
    f => { f.replies["pulls/1"].head.repo.full_name = "foreign/brain-kit"; },
    f => { f.replies["git/ref/heads/main"].object.sha = "a".repeat(40); },
    f => { f.replies["git/ref/heads/lower"].object.sha = "a".repeat(40); },
    f => { f.replies["pulls/2"].head.sha = "a".repeat(40); },
    f => { f.replies["pulls/2"].body = nativeRequestBody("", { ...f.prefix, request: "2".repeat(32) }); },
    f => { f.replies[`git/commits/${f.actual.sha}`].tree.sha = "a".repeat(40); },
    f => { f.replies[`git/commits/${f.actual.parents[0]}`].parents.reverse(); },
    f => { f.env.GITHUB_SHA = "a".repeat(40); },
    f => { delete f.replies["stacks/7"]; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await expect(validateCandidate(f.root, f.event, f.env, f.api, f.actual)).rejects.toThrow();
  }
});

test("emitted native contract gate uses the verified own parent for inherited and own contract edits", async () => {
  for (const ownContract of [false, true]) {
    const f = fixture();
    let head = f.event.pull_request.head.sha;
    if (ownContract) {
      writeFileSync(join(f.root, "docs/integration-contract.md"), "The raft adds its own contract.\n"); f.git("add", ".");
      head = f.git("commit-tree", f.git("write-tree"), "-p", f.prefix.members[0]!.head, "-m", "own contract");
      f.prefix.members[1]!.head = head; f.event.pull_request.head.sha = head;
      f.event.pull_request.body = nativeRequestBody("", f.prefix);
      f.replies["pulls/2"].head.sha = head; f.replies["pulls/2"].body = f.event.pull_request.body;
      f.replies["git/ref/heads/upper"].object.sha = head;
    }
    f.git("update-ref", "HEAD", head);
    const scripts = join(f.root, "scripts"); mkdirSync(scripts);
    const source = resolve(import.meta.dir, "../scripts");
    writeFileSync(join(scripts, "check-contract-pr.ts"), readFileSync(join(source, "check-contract-pr.ts")));
    for (const file of ["proof-reuse.ts", "proof-inputs.ts", "native-candidate.ts"]) symlinkSync(join(source, file), join(scripts, file));
    const eventPath = join(f.root, "event.json"), preload = join(f.root, "api.ts");
    writeFileSync(eventPath, JSON.stringify(f.event));
    writeFileSync(preload, `const replies = ${JSON.stringify(f.replies)}; globalThis.fetch = async input => {
      const key=String(input).replace("https://api.github.com/repos/fixture/brain-kit/", "");
      if (!(key in replies)) throw new Error("Unexpected offline API " + input); return Response.json(replies[key]);
    };`);
    const child = Bun.spawn([process.execPath, "--preload", preload, join(scripts, "check-contract-pr.ts"), f.prefix.trunk.sha, head], {
      cwd: f.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: f.env.GITHUB_REPOSITORY,
        GH_TOKEN: "offline-fixture-token", PR_TITLE: "fix(core): repair the raft", PR_LABELS: "[]" },
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(ownContract ? 1 : 0);
    if (ownContract) expect(err).toContain("docs/integration-contract.md changed, but the title does not start with");
    else expect(out).toContain("unchanged; not a contract change");
  }
});

test("native request executable freezes before ready, verifies read-only, and refuses changed contributors", async () => {
  for (const mode of ["request", "verify", "changed"] as const) {
    const f = fixture(), bin = join(f.root, "bin"), state = join(f.root, "api-state.json"), calls = join(f.root, "calls.jsonl");
    mkdirSync(bin); writeFileSync(state, JSON.stringify(f.replies));
    const gh = join(bin, "gh");
    writeFileSync(gh, `#!${process.execPath}
      import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
      const args=process.argv.slice(2), state=${JSON.stringify(state)}, calls=${JSON.stringify(calls)};
      const replies=JSON.parse(readFileSync(state,"utf8"));appendFileSync(calls,JSON.stringify(args)+"\\n");
      if(args[0]==="repo") console.log("fixture/brain-kit");
      else if(args[0]==="api") {const key=args[1].replace("repos/fixture/brain-kit/","");if(!(key in replies))throw new Error("Unexpected offline API "+key);console.log(JSON.stringify(replies[key]));}
      else if(args[0]==="pr"&&args[1]==="ready") replies["pulls/2"].draft=args.includes("--undo");
      else if(args[0]==="pr"&&args[1]==="edit") {replies["pulls/2"].body=readFileSync(args[args.indexOf("--body-file")+1],"utf8");
        if(${JSON.stringify(mode)}==="changed")replies["git/ref/heads/lower"].object.sha="a".repeat(40);}
      else throw new Error("Unexpected offline command "+JSON.stringify(args));
      writeFileSync(state,JSON.stringify(replies));
    `); chmodSync(gh, 0o755);
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../scripts/request-candidate.ts"), ...(mode === "verify" ? ["--verify"] : []), "2"], {
      cwd: f.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(mode === "changed" ? 1 : 0);
    const issued = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    const final = JSON.parse(readFileSync(state, "utf8"));
    if (mode === "verify") {
      expect(issued.every(args => ["repo", "api"].includes(args[0]!)), "VERIFY_NEVER_MUTATES_PR").toBe(true);
      expect(JSON.parse(out).verified).toBe(true);
    } else {
      const ready = issued.filter(args => args[0] === "pr" && args[1] === "ready");
      expect(ready[0]).toContain("--undo");
      expect(final["pulls/2"].draft).toBe(mode === "changed");
      if (mode === "changed") expect(ready).toHaveLength(1);
      else {
        expect(issued.at(-1)?.slice(0, 3)).toEqual(["pr", "ready", "2"]);
        expect(JSON.parse(out).prefix.members).toEqual(f.prefix.members);
      }
    }
  }
});

test("matching content trees cannot authorize a foreign or truncated synthetic chain", async () => {
  const f = fixture();
  const wrong = f.git("commit-tree", f.actual.tree, "-p", f.prefix.trunk.sha, "-p", f.prefix.members[1]!.head, "-m", "missing lower synthetic");
  const actual = { ...f.actual, sha: wrong, parents: [f.prefix.trunk.sha, f.prefix.members[1]!.head] };
  f.env.GITHUB_SHA = wrong;
  f.replies[`git/commits/${wrong}`] = { sha: wrong, tree: { sha: actual.tree }, parents: actual.parents.map(sha => ({ sha })) };
  await expect(validateCandidate(f.root, f.event, f.env, f.api, actual)).rejects.toThrow();
});

test("a complete same-tree synthetic chain must terminate at the exact frozen trunk", async () => {
  const f = fixture();
  const extra = f.git("commit-tree", f.git("rev-parse", `${f.prefix.trunk.sha}^{tree}`), "-p", f.prefix.trunk.sha, "-m", "foreign trunk");
  const lower = f.git("commit-tree", f.git("rev-parse", `${f.prefix.members[0]!.head}^{tree}`), "-p", extra, "-p", f.prefix.members[0]!.head, "-m", "foreign lower");
  const top = f.git("commit-tree", f.actual.tree, "-p", lower, "-p", f.prefix.members[1]!.head, "-m", "foreign top");
  for (const id of [top, lower]) {
    const [sha, tree, ...parents] = f.git("show", "-s", "--format=%H %T %P", id).split(" ");
    f.replies[`git/commits/${id}`] = { sha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })) };
  }
  f.env.GITHUB_SHA = top;
  await expect(validateCandidate(f.root, f.event, f.env, f.api, { ...f.actual, sha: top, parents: [lower, f.prefix.members[1]!.head] })).rejects.toThrow("exact frozen trunk");
});

test("native contract comparison excludes inherited contract changes but catches its own", async () => {
  const f = fixture();
  const verified = await verifyNativePrefix(f.event, f.env, f.api, true);
  const own = changedFiles(f.root, ownNativeParent(verified), f.event.pull_request.head.sha)!;
  expect(own).toEqual(["raft.md"]);
  expect(judge("fix(core): repair the raft", [], own).ok).toBe(true);
  expect(judge("fix(core): repair the raft", [], changedFiles(f.root, f.prefix.trunk.sha, f.event.pull_request.head.sha)!).ok).toBe(false);
  expect(judge("fix(core): repair the raft", [], ["docs/integration-contract.md"]).ok).toBe(false);
});
