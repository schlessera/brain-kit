/**
 * Proves that a test can fail: break the thing it protects, watch the test go
 * red for the reason claimed, restore, watch it go green again.
 *
 * "A green test is evidence only if it could have been red"
 * (docs/process/testing.md, "Tests that cannot fail"). Checking that takes a
 * mutation, not reasoning, and this is the mutation done the same way every
 * time: the receipt records whether the mutant was killed, survived, failed
 * for another reason, or only failed to load. A module-load error is not a
 * behavioural failure, so it never counts as a kill.
 *
 * The mutation is a patch. `--from-worktree` takes the unstaged changes of the
 * named paths as the patch, which is the easy way to make one: stage the real
 * work, break the code in the working tree, and let this command capture and
 * revert it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutput, TestRunner } from "./runner";

export type MutationVerdict = "killed" | "survived" | "wrong-reason" | "load-error" | "unstable-baseline";

export interface MutationReceipt {
  schemaVersion: 1;
  tool: "test-health mutate";
  at: string;
  test: string;
  name: string | null;
  expect: string;
  patchSha256: string;
  patchFiles: string[];
  verdict: MutationVerdict;
  detail: string;
  runs: Record<"baseline" | "mutated" | "restored", { exitCode: number; wallMs: number; failedCases: string[] } | null>;
}

export interface MutateOptions {
  root: string;
  test: string;
  name?: string;
  /** Text the failing output must contain: the assertion message or the case name. */
  expect: string;
  patch: string;
  runner: TestRunner;
  projects?: string[];
  now?: Date;
}

const LOAD_ERROR = /SyntaxError|Cannot find module|Cannot find package|Module not found|Could not resolve|Export named .* not found|is not exported|Unhandled error between tests/;

function git(root: string, args: string[], input?: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input) });
  if (result.exitCode !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** The unstaged changes of `paths` as a patch. The paths stay modified; `mutate` reverts them. */
export function worktreePatch(root: string, paths: readonly string[]): string {
  const patch = git(root, ["diff", "--no-color", "--binary", "--", ...paths]);
  if (!patch.trim()) throw new Error(`No unstaged change in ${paths.join(", ")}: make the mutation in the working tree first`);
  return patch;
}

export function patchFiles(patch: string): string[] {
  return [...new Set([...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(match => match[2]!))].sort();
}

const digest = (root: string, files: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(existsSync(join(root, file)) ? readFileSync(join(root, file)) : "\0absent");
  return hash.digest("hex");
};

const failedCases = (run: RunOutput): string[] => run.cases.filter(entry => entry.state === "failed").map(entry => entry.name).sort();
const summary = (run: RunOutput) => ({ exitCode: run.exitCode, wallMs: run.wallMs, failedCases: failedCases(run) });
const passed = (run: RunOutput): boolean => run.exitCode === 0 && failedCases(run).length === 0;

/**
 * `applied` says whether the patch is already in the working tree (the
 * `--from-worktree` case). Either way the tree ends as it was before the
 * mutation, and a tree that cannot be restored is an error, not a verdict.
 */
export async function mutate(options: MutateOptions, applied = false): Promise<MutationReceipt> {
  const { root, test, patch } = options;
  if (!options.expect.trim()) throw new Error("--expect is required: name the assertion or case that must fail");
  const files = patchFiles(patch);
  if (!files.length) throw new Error("The mutation patch changes no file");
  if (applied) git(root, ["apply", "-R", "--whitespace=nowarn"], patch);
  else git(root, ["apply", "--check", "--whitespace=nowarn"], patch);
  const clean = digest(root, files);
  const request = { files: [test], name: options.name, projects: options.projects };
  const receipt = (verdict: MutationVerdict, detail: string, runs: MutationReceipt["runs"]): MutationReceipt => ({
    schemaVersion: 1, tool: "test-health mutate", at: (options.now ?? new Date()).toISOString(), test, name: options.name ?? null,
    expect: options.expect, patchSha256: createHash("sha256").update(patch).digest("hex"), patchFiles: files, verdict, detail, runs });

  const baseline = await options.runner(request);
  // Bun matches `-t` against a table test's title before its placeholders are filled in.
  if (options.name && /matched 0 tests/.test(baseline.output)) {
    throw new Error(`--name ${JSON.stringify(options.name)} matched no test in ${test}; for a table test, give the title up to its first placeholder`);
  }
  if (!passed(baseline)) return receipt("unstable-baseline", "the test fails before the mutation", { baseline: summary(baseline), mutated: null, restored: null });

  let mutated: RunOutput;
  git(root, ["apply", "--whitespace=nowarn"], patch);
  try { mutated = await options.runner(request); }
  finally { git(root, ["apply", "-R", "--whitespace=nowarn"], patch); }
  if (digest(root, files) !== clean) throw new Error(`The mutation was not fully reverted in ${files.join(", ")}; restore them before continuing`);
  const restored = await options.runner(request);
  const runs = { baseline: summary(baseline), mutated: summary(mutated), restored: summary(restored) };
  if (!passed(restored)) return receipt("unstable-baseline", "the test fails after the mutation was reverted", runs);
  if (passed(mutated)) return receipt("survived", "the test stays green with the guard broken", runs);
  const failing = failedCases(mutated);
  if (!failing.length && LOAD_ERROR.test(mutated.output)) return receipt("load-error", "the mutant failed to load, which proves nothing about behaviour", runs);
  if (!mutated.output.includes(options.expect) && !failing.some(name => name.includes(options.expect))) {
    return receipt("wrong-reason", `the failure does not mention ${JSON.stringify(options.expect)}`, runs);
  }
  if (options.name && failing.length && !failing.some(name => name.includes(options.name!))) {
    return receipt("wrong-reason", `another case failed, not ${JSON.stringify(options.name)}`, runs);
  }
  return receipt("killed", "the test fails with the guard broken and passes with it restored", runs);
}
