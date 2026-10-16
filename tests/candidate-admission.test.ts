import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { proofCadence } from "../scripts/ci-plan";

const ROOT = resolve(import.meta.dir, "..");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function admission(mismatch: boolean, action = "ready_for_review", draft = false) {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-candidate-admission-"));
  directories.push(dir);
  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid", GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid" } });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  }
  git("init", "-q");
  writeFileSync(join(dir, "raft.md"), "# The crossing\n"); git("add", ".");
  const tree = git("write-tree"), base = git("commit-tree", tree, "-m", "base");
  const head = git("commit-tree", tree, "-p", base, "-m", "head");
  const merge = git("commit-tree", tree, "-p", base, "-p", head, "-m", "candidate");
  git("update-ref", "HEAD", merge);
  symlinkSync(join(ROOT, "scripts"), join(dir, "scripts"));
  const event = { action, pull_request: { number: 7, draft, head: { sha: head }, base: { sha: mismatch ? head : base, ref: "main" } } };
  writeFileSync(join(dir, "event.json"), JSON.stringify(event));
  const replies = {
    "pulls/7": { state: "open", draft: false, head: { sha: head }, base: { ref: "main", repo: { full_name: "fixture/brain-kit" } } },
    "git/ref/heads/main": { object: { sha: base } },
    [`git/commits/${merge}`]: { sha: merge, tree: { sha: tree }, parents: [base, head].map(sha => ({ sha })) },
  };
  writeFileSync(join(dir, "api.ts"), `const replies = ${JSON.stringify(replies)}; globalThis.fetch = async input => {
    const key = String(input).replace("https://api.github.com/repos/fixture/brain-kit/", "");
    if (!(key in replies)) throw new Error("Unexpected offline API request: " + input);
    return Response.json(replies[key]);
  };`);
  const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: { changeset: { steps: Array<{ run?: string; if?: string }> } };
  };
  const step = workflow.jobs.changeset.steps.find(step => step.run === "bun scripts/candidate-proof.ts");
  const env = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(dir, "event.json"),
    GITHUB_SHA: merge, GITHUB_REPOSITORY: "fixture/brain-kit", GH_TOKEN: "offline-fixture-token" };
  const cadence = proofCadence(env, event);
  let code = 0, out = "", err = "";
  if (step && (!step.if || step.if === `steps.plan.outputs.cadence == '${cadence}'`)) {
    const child = Bun.spawn([process.execPath, "--preload", join(dir, "api.ts"), "scripts/candidate-proof.ts"], {
      cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  }
  // This real product child can be dispatched only after successful metadata.
  if (code === 0) {
    const product = Bun.spawn([process.execPath, "-e", 'await Bun.write("product-dispatched", "yes")'], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(await product.exited).toBe(0);
  }
  return { code, out, err, dispatched: existsSync(join(dir, "product-dispatched")) };
}

test("confirmation metadata rejects incompatible checkout before a product child can dispatch", async () => {
  const result = await admission(true);
  expect(result.dispatched, "NO_PRODUCT_DISPATCH_BEFORE_CANDIDATE_ADMISSION").toBe(false);
  expect(result.code).toBe(1);
  expect(result.err).toContain("checkout does not match the requested head/base merge identity");
});

test("matching confirmation metadata admits the same candidate", async () => {
  const result = await admission(false);
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain("BRAIN_CANDIDATE_RECEIPT");
  expect(result.dispatched).toBe(true);
});

test("draft and synchronize metadata preserve feedback instead of demanding final confirmation", async () => {
  for (const [action, draft] of [["opened", true], ["synchronize", false]] as const) {
    const result = await admission(true, action, draft);
    expect(result.code, result.err).toBe(0);
    expect(result.out).not.toContain("BRAIN_CANDIDATE_RECEIPT");
    expect(result.dispatched).toBe(true);
  }
});
