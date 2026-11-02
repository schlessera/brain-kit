/**
 * Red-main entry points (#2942):
 *   gate        first step of PR proof: refuse doomed hosted proof while main is red
 *   coordinate  workflow_run handler for main CI and triage probes
 *   probe       rerun only the named test files at one SHA (triage, never proof)
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { changedFiles, planChecks, proofSelections, redMainSnapshot, workspaces } from "./ci-plan";
import { GitReservationStore, reservationServerTime, type Snapshot as StoreSnapshot } from "./integration-reservation";
import { coordinate, type CoordinatorIO, type WorkflowRun } from "./red-main-coordinator";
import { gateDecision, type Category } from "./red-main";
import { PROBE_RECEIPT } from "./red-main-expedite";

// Hosted jobs run from the checkout root; fixtures run from their own repository.
const root = process.cwd();

function run(argv: string[], cwd = root, input?: string): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : new TextEncoder().encode(input) });
  return { code: result.exitCode ?? 1, out: new TextDecoder().decode(result.stdout), err: new TextDecoder().decode(result.stderr) };
}
function must(argv: string[], cwd = root, input?: string): string {
  const result = run(argv, cwd, input);
  if (result.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${result.err.trim()}`);
  return result.out.trim();
}

/** Ancestry with an on-demand fetch; anything other than a definite answer fails closed. */
export function isAncestor(ancestor: string, descendant: string, cwd = root): boolean {
  for (const sha of [ancestor, descendant]) if (sha !== "HEAD" && run(["git", "cat-file", "-e", `${sha}^{commit}`], cwd).code !== 0) must(["git", "fetch", "--no-tags", "origin", sha], cwd);
  const result = run(["git", "merge-base", "--is-ancestor", ancestor, descendant], cwd);
  if (result.code === 0 || result.code === 1) return result.code === 0;
  throw new Error(`Cannot determine ancestry: ${result.err.trim()}`);
}

/** Whether a failure belongs to the squash's own affected closure; null when the graph cannot say. */
export function inClosure(sha: string, failure: { test: string | null; category: Category }): boolean | null {
  try {
    const parent = must(["git", "rev-parse", `${sha}^`]);
    const plan = planChecks(changedFiles(root, parent, sha, false), workspaces(root), root, true);
    if (plan.global) return null;
    if (failure.test) {
      if (plan.unitTests) return plan.unitTests.includes(failure.test);
      const dir = /^packages\/([^/]+)\//.exec(failure.test)?.[1];
      return dir ? plan.local.fullTests && plan.affected.includes(dir) : null;
    }
    if (failure.category === "changeset") return true;
    return proofSelections({ ...plan, cadence: "integrated" })[failure.category] ?? null;
  } catch { return null; }
}

async function gh(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : new TextEncoder().encode(input) });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${err.trim()}`);
  return out;
}

function liveIO(repository: string): CoordinatorIO {
  const store = new GitReservationStore(root);
  return {
    repository,
    async json(path) { return JSON.parse(await gh(["api", path])); },
    async write(method, path, body) {
      const out = await gh(["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body));
      return out.trim() ? JSON.parse(out) : {};
    },
    async now() { return reservationServerTime(await gh(["api", "--include", "-H", "Cache-Control: no-cache", `repos/${repository}/git/ref/heads/main?red_main_clock=${crypto.randomUUID()}`])); },
    read() { return store.read(); },
    publish(snapshot, record) { return store.publishRedMain(snapshot as StoreSnapshot, record); },
    async artifactFiles(runId, name, file) {
      const listing = JSON.parse(await gh(["api", `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`]));
      if (!(listing.artifacts ?? []).some((artifact: { name: string; expired: boolean }) => artifact.name === name && !artifact.expired)) return [];
      const dir = mkdtempSync(join(tmpdir(), "red-main-artifact-"));
      try {
        await gh(["run", "download", String(runId), "--repo", repository, "--name", name, "--dir", dir]);
        const found: string[] = [];
        const walk = (path: string) => { for (const entry of readdirSync(path)) { const full = join(path, entry); if (statSync(full).isDirectory()) walk(full); else if (entry === file) found.push(readFileSync(full, "utf8")); } };
        walk(dir);
        return found;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    async log(job) { return gh(["api", "--allow-escape-sequences", `repos/${repository}/actions/jobs/${job}/logs`]); },
    inClosure,
    range(since, until) { return must(["git", "rev-list", "--first-parent", "--reverse", `${since}..${until}`]).split("\n").filter(Boolean); },
    isAncestor: (a, b) => isAncestor(a, b),
    commitTime(sha) { return Number(must(["git", "show", "-s", "--format=%ct", sha])) * 1000; },
    async recordEvent(event) {
      const dir = join(root, "tmp/red-main-events"), file = join(dir, `input-${crypto.randomUUID()}.json`);
      await Bun.write(file, JSON.stringify(event));
      must([process.execPath, "scripts/ci-timings.ts", "record", "--repo", repository, "--event", file, "--out", dir]);
      rmSync(file);
    },
    print(line) { console.log(line); },
  };
}

if (import.meta.main) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "gate") {
      const pr = Number(process.env.PR_NUMBER);
      if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error("PR_NUMBER is required");
      const { record } = redMainSnapshot(root, undefined);
      const decision = record ? gateDecision({ record, pr, contains: sha => isAncestor(sha, "HEAD") }) : { refuse: false, message: "main green: no coordination record" };
      if (decision.refuse) { console.error(`::error::${decision.message}`); console.error(decision.message); process.exit(1); }
      console.log(decision.message);
    } else if (command === "coordinate" && rest[0] === "--dry-run") {
      // Read-only replay against a recorded run: every write is printed, none is sent.
      const id = rest[rest.indexOf("--run") + 1] ?? "", repository = must(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
      if (!/^[1-9]\d*$/.test(id)) throw new Error("usage: coordinate --dry-run --run <id>");
      const io = liveIO(repository), seen = io.read();
      let record = seen.redMain;
      const run = await io.json(`repos/${repository}/actions/runs/${id}`) as WorkflowRun;
      await coordinate({ ...io,
        read: () => ({ ...seen, redMain: record }),
        publish(_snapshot, next) { record = next; console.log(`DRY_RUN record ${JSON.stringify(next)}`); return true; },
        async write(method, path, body) { console.log(`DRY_RUN ${method} ${path} ${JSON.stringify(body ?? null)}`); return { number: 999_999 }; },
        async recordEvent(event) { console.log(`DRY_RUN event ${JSON.stringify(event)}`); },
      }, run);
    } else if (command === "coordinate") {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
      const repository = process.env.GITHUB_REPOSITORY!;
      if (!event.workflow_run || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("A workflow_run event and repository are required");
      await coordinate(liveIO(repository), event.workflow_run as WorkflowRun);
    } else if (command === "probe") {
      const target = resolve(rest[rest.indexOf("--target") + 1] ?? "");
      const tests = JSON.parse(process.env.PROBE_TESTS ?? "[]") as unknown, purpose = process.env.PROBE_PURPOSE ?? "flake";
      if (!["flake", "bisect", "fix"].includes(purpose)) throw new Error("Unknown probe purpose");
      if (!Array.isArray(tests) || !tests.length || tests.length > 50 || tests.some(test => typeof test !== "string" ||
          !/^[A-Za-z0-9_./@-]+\.test\.[cm]?[jt]sx?$/.test(test) || test.split("/").includes(".."))) throw new Error("Probe tests must be test file paths");
      const present = (tests as string[]).filter(test => existsSync(join(target, test))), absent = (tests as string[]).filter(test => !present.includes(test));
      // Only an expedited fix probe may find a file absent: a targeted revert can delete the failing test it reverts.
      if (absent.length && purpose !== "fix") throw new Error("Probe tests must be existing test files at the probed SHA");
      const exitCode = present.length ? await Bun.spawn([process.execPath, "run", "test", ...present], { cwd: target, stdout: "inherit", stderr: "inherit" }).exited : 0;
      console.log(`${PROBE_RECEIPT} ${JSON.stringify({ purpose, sha: must(["git", "rev-parse", "HEAD"], target), tests: present, absent, exitCode })}`);
      process.exit(exitCode);
    } else throw new Error("usage: bun scripts/red-main-cli.ts gate | coordinate [--dry-run --run <id>] | probe --target <checkout>");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
