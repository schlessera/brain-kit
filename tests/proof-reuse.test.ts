import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { browserInventory, checkout, git, normalizeInventory, proofInputs, type Inputs, type Spec } from "../scripts/proof-inputs";
import { boundedLedger, contextFromEvent, findRetained, receiptFromLog, retainedCategories, validateSource, type API, type Context, type FreshReceipt, type Source } from "../scripts/proof-reuse";
import { proofProblems, PROOF_JOBS } from "../scripts/ci-proof";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const runner = "ubuntu-24.04/fixed/Linux/X64/bun-1.4.2";
const layout = "packages/ui-react/tests/browser/one.layout.tsx";
const secondLayout = "packages/ui-react/tests/browser/two.layout.tsx";
const visual = "packages/ui-kit/tests/visual/one.visual.tsx";
const secondVisual = "packages/ui-kit/tests/visual/two.visual.tsx";
const shared = "packages/ui-react/tests/browser/shared.offline.tsx";
const inventory: Spec[] = normalizeInventory([
  { project: "visual", file: visual }, { project: "visual", file: secondVisual },
  { project: "rail-fine", file: shared }, { project: "ui-react-layout", file: shared },
  { project: "ui-react-layout", file: layout }, { project: "ui-react-layout", file: secondLayout },
]);
function write(root: string, file: string, text: string) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
function commit(root: string): string {
  git(root, "add", "."); git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "fixture");
  return checkout(root).sha;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "proof-reuse-")); roots.push(root); git(root, "init", "-q");
  git(root, "config", "commit.gpgsign", "false");
  for (const file of [layout, secondLayout, visual, secondVisual, shared]) write(root, file, "export {};\n");
  write(root, "scripts/browser-shard-costs.json", JSON.stringify({ seconds: { [`visual::${visual}`]: 1 } }));
  write(root, "scripts/ci-proof.ts", "// unchanged proof harness\n");
  write(root, ".github/workflows/ci.yml", "name: CI\n");
  write(root, "packages/core/fixtures/corpus/input.md", "Fixture source\n"); const base = commit(root);
  write(root, "pr-input.txt", "immutable contribution\n"); const head = commit(root);
  const merged = git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit-tree", checkout(root).tree, "-p", base, "-p", head, "-m", "combined fixture").trim();
  git(root, "reset", "--hard", merged);
  return root;
}
const context: Context = { repository: "schlessera/brain-kit", headRepository: "schlessera/brain-kit", branch: "chore/fixture", pr: 42, run: 100 };
function evidence(root: string, inputs: Inputs) {
  const identity = checkout(root);
  const receipts: FreshReceipt[] = [1, 2].map(shard => ({ version: 1, category: "browser", shard: `${shard}/2`, checkout: identity, inputs }));
  const source: Source = { run: 90, attempt: 1, jobs: [101, 102], checkout: identity, inputs };
  const calls: string[] = [];
  const run = { id: 90, event: "pull_request", status: "completed", conclusion: "success", run_attempt: 1,
    head_sha: identity.parents[1], head_branch: context.branch, path: ".github/workflows/ci.yml", head_repository: { full_name: context.headRepository }, repository: { full_name: context.repository }, created_at: new Date().toISOString() };
  const jobs = [101, 102].map((id, i) => ({ id, run_id: 90, head_sha: identity.parents[1], name: `browser (${i + 1})`, status: "completed", conclusion: "success", check_run_url: `https://api.github.com/repos/${context.repository}/check-runs/${id}`,
    steps: [{ name: "Complete browser proof", status: "completed", conclusion: "success" }] }));
  const logs = receipts.map(r => `2026-07-12T00:00:00Z ${identity.sha}\n2026-07-12T00:00:01Z refs/remotes/pull/42/merge\n2026-07-12T00:00:02Z BRAIN_PROOF_RECEIPT ${JSON.stringify(r)}\n`);
  const api: API = {
    async json(path) {
      calls.push(path);
      if (path === "actions/runs/90/attempts/1") return run;
      if (path === "actions/runs/90/attempts/1/jobs?per_page=100") return { total_count: 2, jobs };
      if (path.startsWith("check-runs/")) return { id: Number(path.split("/").at(-1)), head_sha: identity.parents[1], status: "completed", conclusion: "success", app: { slug: "github-actions" } };
      if (path === `git/commits/${identity.sha}`) return { sha: identity.sha, tree: { sha: identity.tree }, parents: identity.parents.map(sha => ({ sha })) };
      throw new Error(`Unexpected API ${path}`);
    },
    async log(id) { calls.push(`log/${id}`); return logs[id - 101]!; },
  };
  return { api, source, run, jobs, logs, calls };
}
test("a changed foreign leaf retains browser inputs; shared specs and every source/fixture/harness invalidate them", () => {
  const root = fixture(); const first = proofInputs(root, "browser", inventory, runner);
  expect(first.excluded).toContain(layout); expect(first.excluded).not.toContain(shared);
  write(root, layout, "// changed layout-only assertion\n"); commit(root);
  expect(proofInputs(root, "browser", inventory, runner).fingerprint).toBe(first.fingerprint);
  const baseline = checkout(root).sha;
  for (const file of [visual, shared, "scripts/ci-proof.ts", "packages/core/fixtures/corpus/input.md", "bun.lock", "unknown/new-input.bin"]) {
    write(root, file, "changed\n"); commit(root);
    expect(proofInputs(root, "browser", inventory, runner).fingerprint, file).not.toBe(first.fingerprint);
    git(root, "reset", "--hard", baseline); git(root, "clean", "-fd");
  }
  expect(proofInputs(root, "browser", inventory, runner + "/changed").fingerprint).not.toBe(first.fingerprint);
});
test("referenced foreign leaves join input closure; new discovery and partition ownership cannot disappear", () => {
  const root = fixture(); write(root, "scripts/helper.ts", `import "../${layout}";\n`); commit(root);
  const inputs = proofInputs(root, "browser", inventory, runner); expect(inputs.excluded).not.toContain(layout);
  write(root, layout, "changed\n"); commit(root);
  expect(proofInputs(root, "browser", inventory, runner).fingerprint).not.toBe(inputs.fingerprint);
  write(root, "packages/ui-kit/tests/visual/new.visual.tsx", "export {};\n"); commit(root);
  const discovered = normalizeInventory([...inventory, { project: "visual", file: "packages/ui-kit/tests/visual/new.visual.tsx" }]);
  expect(proofInputs(root, "browser", discovered, runner).partitions.flat()).toContain("visual::packages/ui-kit/tests/visual/new.visual.tsx");
  expect(() => proofInputs(root, "browser", inventory, runner, "HEAD", [shared])).toThrow("input ownership");
  expect(() => proofInputs(root, "browser", inventory, "")).toThrow("Unknown runner");
});
test("logs must contain one fresh receipt tied to the actual checkout and correct shard", () => {
  const root = fixture(); const { logs } = evidence(root, proofInputs(root, "browser", inventory, runner));
  expect(receiptFromLog(logs[0]!, "browser", 1).checkout).toEqual(checkout(root));
  expect(() => receiptFromLog(logs[0]! + logs[0], "browser", 1)).toThrow("ambiguous");
  expect(() => receiptFromLog(logs[0]!.split("\n").slice(1).join("\n"), "browser", 1)).toThrow("actual job checkout");
  expect(() => receiptFromLog(logs[0]!, "browser", 2)).toThrow("Wrong fresh");
});
test("successful immutable source receipts validate against APIs", async () => {
  const root = fixture(), inputs = proofInputs(root, "browser", inventory, runner);
  const valid = evidence(root, inputs);
  await validateSource(root, "browser", valid.source, inputs, context, valid.api);
  expect(valid.calls.length).toBeGreaterThan(0);
  // Retain the older checkout spelling alongside v7's actual remote ref.
  valid.logs[0] = valid.logs[0]!.replace("refs/remotes/pull/42/merge", "refs/pull/42/merge");
  await validateSource(root, "browser", valid.source, inputs, context, valid.api);
});
test("cancelled, missing, foreign and mismatched evidence is rejected", async () => {
  const root = fixture(), inputs = proofInputs(root, "browser", inventory, runner);
  for (const state of ["cancelled", "failure", "action_required", "waiting"]) {
    const bad = evidence(root, inputs); bad.run.conclusion = state;
    await expect(validateSource(root, "browser", bad.source, inputs, context, bad.api)).rejects.toThrow("successful automatic");
  }
  const mismatch = evidence(root, inputs); mismatch.source.inputs = { ...inputs, fingerprint: "0".repeat(64) };
  await expect(validateSource(root, "browser", mismatch.source, inputs, context, mismatch.api)).rejects.toThrow("input equivalence");
  const missing = evidence(root, inputs); missing.jobs[1]!.conclusion = "skipped";
  await expect(validateSource(root, "browser", missing.source, inputs, context, missing.api)).rejects.toThrow("fresh successful job");
  const foreign = evidence(root, inputs); foreign.run.head_repository.full_name = "odysseus/other";
  await expect(validateSource(root, "browser", foreign.source, inputs, context, foreign.api)).rejects.toThrow("successful automatic");
  const forged = evidence(root, inputs); forged.logs[0] = forged.logs[0]!.replace("refs/remotes/pull/42/merge", "refs/remotes/pull/43/merge");
  await expect(validateSource(root, "browser", forged.source, inputs, context, forged.api)).rejects.toThrow("source pull request");
});
test("changed source blobs cannot use a forged matching fingerprint or an old receipt", async () => {
  const root = fixture(), inputs = proofInputs(root, "browser", inventory, runner), original = evidence(root, inputs);
  write(root, "scripts/ci-proof.ts", "changed harness\n"); commit(root);
  const changed = proofInputs(root, "browser", inventory, runner);
  original.source.inputs = changed;
  original.logs = original.logs.map(log => log.replace(JSON.stringify(inputs), JSON.stringify(changed)));
  const api: API = { json: original.api.json, async log(id) { return original.logs[id - 101]!; } };
  await expect(validateSource(root, "browser", original.source, changed, context, api)).rejects.toThrow("Immutable source inputs");
});
test("missing, invalid or stale current ledger cannot bless skipped selected proof", async () => {
  const root = fixture();
  for (const ledger of [null, {}, { version: 1, checkout: checkout(root), retained: [] }, { version: 1, checkout: { sha: "0".repeat(40) }, retained: {} }]) {
    await expect(retainedCategories(root, ledger, undefined, undefined)).rejects.toThrow("current-head proof ledger");
  }
  const needs: Record<string, { result: string; outputs?: Record<string, string> }> = { changeset: { result: "success", outputs: Object.fromEntries(PROOF_JOBS.map(name => [name, "true"])) },
    ...Object.fromEntries(PROOF_JOBS.map(name => [name, { result: name === "browser" ? "skipped" : "success" }])) };
  expect(proofProblems(needs)).toContain("browser: selected proof did not pass (skipped)");
  expect(proofProblems(needs, new Set(["browser"]))).toEqual([]);
  needs.browser = { result: "failure" };
  expect(proofProblems(needs, new Set(["browser"]))).toContain("browser: retained proof must skip fresh execution (failure)");
});
test("lookup retains a complete fresh pair, conservatively declines mismatches and never chains skipped proof", async () => {
  const root = fixture(), inputs = proofInputs(root, "browser", inventory, runner), original = evidence(root, inputs);
  const sourceJSON = original.api.json;
  const api: API = { ...original.api, async json(path) {
    if (path.startsWith("actions/workflows/")) return { workflow_runs: [original.run] };
    return sourceJSON(path);
  } };
  expect((await findRetained(root, { browser: true }, context, api, inventory, runner)).browser).toEqual(original.source);
  original.jobs[0]!.conclusion = "skipped";
  expect(await findRetained(root, { browser: true }, context, api, inventory, runner)).toEqual({});
  original.jobs[0]!.conclusion = "success";
  write(root, visual, "changed assertion\n"); commit(root);
  expect(await findRetained(root, { browser: true }, context, api, inventory, runner)).toEqual({});
});
test("nonautomatic, draft and deleted-head contexts are fresh; fork ready PR lookup remains read-only", () => {
  const event = { pull_request: { number: 42, draft: false, head: { ref: context.branch, repo: { full_name: "odysseus/brain-kit" } } } };
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: context.repository, GITHUB_RUN_ID: "100" };
  expect(contextFromEvent(event, env)?.headRepository).toBe("odysseus/brain-kit");
  expect(contextFromEvent(event, { ...env, GITHUB_EVENT_NAME: "schedule" })).toBeUndefined();
  expect(contextFromEvent(event, { ...env, GITHUB_EVENT_NAME: "push" })).toBeUndefined();
  expect(contextFromEvent(event, { ...env, GITHUB_ACTIONS: "" })).toBeUndefined();
  event.pull_request.draft = true; expect(contextFromEvent(event, env)).toBeUndefined();
  event.pull_request.draft = false; event.pull_request.head.repo.full_name = ""; expect(contextFromEvent(event, env)).toBeUndefined();
});
test("the actual compiler input inventory includes test leaves used by a build", () => {
  const root = fixture();
  write(root, "packages/ui-react/tsconfig.build.json", JSON.stringify({ compilerOptions: { jsx: "react-jsx" }, include: ["tests/browser/**/*.tsx"] })); commit(root);
  expect(proofInputs(root, "browser", inventory, runner).excluded).not.toContain(layout);
});
test("native discovery consumes the JSON file, preserving colored console diagnostics as diagnostics", async () => {
  const root = fixture();
  write(root, "scripts/visual.mjs", 'const projects = projectArgs.length ? [] : ["visual", "rail-fine"];\n');
  const original = Bun.spawn;
  const spawn = spyOn(Bun, "spawn").mockImplementationOnce(((argv: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const output = argv.find((arg: string) => arg.startsWith("--json="))?.slice("--json=".length);
    if (output) writeFileSync(output, JSON.stringify(inventory.map(s => ({ file: join(root, s.file), projectName: `${s.project} (chromium)` }))));
    return original([process.execPath, "-e", 'console.log("\\u001b[31mconsole diagnostic\\u001b[0m");'], options);
  }) as typeof Bun.spawn);
  try { expect(await browserInventory(root)).toEqual(inventory); }
  finally { spawn.mockRestore(); }
});
test("Git-derived, unknown dynamic module selection and exported foreign helpers refuse retention", () => {
  const root = fixture();
  for (const name of ["GITHUB_SHA", "GITHUB_RUN_ID"]) {
    write(root, visual, `const input = process.env.${name};\n`); commit(root);
    expect(() => proofInputs(root, "browser", inventory, runner)).toThrow("Git-dependent or unknown");
  }
  write(root, visual, "const input = await import(modulePath);\n"); commit(root);
  expect(() => proofInputs(root, "browser", inventory, runner)).toThrow("Git-dependent or unknown");
  write(root, visual, 'const input = Bun.spawn(["git", "rev-parse", "HEAD"]);\n'); commit(root);
  expect(() => proofInputs(root, "browser", inventory, runner)).toThrow("Git-dependent or unknown");
  write(root, visual, "export {};\n"); write(root, layout, "export const helper = 1;\n"); commit(root);
  expect(proofInputs(root, "browser", inventory, runner).excluded).not.toContain(layout);
});

test("large receipts fall back to fresh proof before crossing the native environment envelope", async () => {
  const root = fixture(), inputs = proofInputs(root, "browser", inventory, runner), { source } = evidence(root, inputs);
  const ledger = { version: 1 as const, checkout: checkout(root), retained: { browser: source } };
  expect(boundedLedger(ledger).retained.browser).toEqual(source);
  source.inputs = { ...inputs, runner: "\\".repeat(100000) };
  expect(Buffer.byteLength(JSON.stringify(JSON.stringify(ledger)))).toBeGreaterThan(131072);
  const bounded = boundedLedger(ledger);
  const child = Bun.spawn([process.execPath, "-e", 'const needs=JSON.parse(process.env.PROOF_NEEDS);if(Object.keys(JSON.parse(needs.changeset.outputs.reuse).retained).length)process.exit(1);console.log("fresh");'], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, PROOF_NEEDS: JSON.stringify({ changeset: { outputs: { reuse: JSON.stringify(bounded) } } }) },
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0); expect(out.trim()).toBe("fresh"); expect(bounded.checkout).toEqual(ledger.checkout);
});
