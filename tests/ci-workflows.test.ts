/** Preserve contribution routing, scheduling and hostile-metadata proof on GitHub Actions. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CI_WORKFLOWS, checkCIWorkflows, publicationWorkflowProblems, workflowProblems } from "../scripts/check-ci-workflows.ts";
const ROOT = resolve(import.meta.dir, "..");
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
type Step = Obj & { uses?: string; with?: Obj; run?: string; env?: Obj };
type Job = Obj & { steps: Step[]; "runs-on": string; if?: string; name?: string };
type Workflow = Obj & { name: string; on: Obj; jobs: Record<string, Job> };
const read = (file: string) => readFileSync(join(ROOT, ".github/workflows", file), "utf8");
const workflows = CI_WORKFLOWS.map(file => ({ file, workflow: Bun.YAML.parse(read(file)) as Workflow }));
const ci = workflows.find(w => w.file === "ci.yml")!.workflow;
const REPO = "schlessera/brain-kit";
test("confirmation metadata cannot omit identity admission or apply it to draft feedback", () => {
  const source = read("ci.yml");
  const guard = /      - name: Validate requested candidate before product proof\n[\s\S]*?        run: bun scripts\/candidate-proof.ts\n/;
  expect(source).toMatch(guard);
  expect(workflowProblems(source.replace(guard, ""), "ci.yml").join("\n")).toContain("confirmation admission must validate identity");
  expect(workflowProblems(source.replace("if: steps.plan.outputs.cadence == 'confirmation'", "if: always()"), "ci.yml").join("\n")).toContain("confirmation admission must validate identity");
});
const pullRequest = (headRepo: string | null, extra: Obj = {}): Obj => ({
  event_name: "pull_request", repository: REPO,
  event: { pull_request: { number: 7, title: "fix(core): steer between Scylla and Charybdis", labels: [],
    head: { sha: "1".repeat(40), repo: headRepo === null ? null : { full_name: headRepo } }, ...extra } },
});
function runs(workflow: Workflow, job: Job, context: Obj): boolean {
  return String(context.event_name) in workflow.on && (job.if === undefined || evaluate(job.if, {
    github: context, needs: { changeset: { result: "success", outputs: { verify: "true", pack: "true", unit: "true", runtime: "true", runtime_host: "true", browser: "true", layout: "true", captures: "true", endurance: "true", run_browser: "true", run_layout: "true" } }, pack: { result: "success" } },
  }) === true);
}
function evaluate(expression: string, context: Obj): Json {
  expression = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const tokens = expression.match(/'[^']*'|==|!=|&&|\|\||\(|\)|[A-Za-z_][A-Za-z0-9_.-]*|\S/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++]!;
  const equal = (a: Json, b: Json) =>
    typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const truthy = (v: Json) => v !== null && v !== false && v !== 0 && v !== "";
  function primary(): Json {
    const token = take();
    if (token === "!") return !truthy(primary());
    if ((token === "cancelled" || token === "always") && peek() === "(") {
      take();
      if (take() !== ")") throw new Error(`cancelled takes no arguments in ${expression}`);
      return token === "always" || context.cancelled === true;
    }
    if (token === "(") {
      const value = or();
      if (take() !== ")") throw new Error(`unbalanced parentheses in ${expression}`);
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === "null") return null;
    if (!/^[A-Za-z_]/.test(token)) throw new Error(`unsupported token ${token} in ${expression}`);
    let value: Json = context;
    for (const part of token.split(".")) {
      value = value !== null && typeof value === "object" && !Array.isArray(value) ? (value[part] ?? null) : null;
    }
    return value;
  }
  function comparison(): Json {
    const left = primary();
    if (peek() === "==") return take(), equal(left, primary());
    if (peek() === "!=") return take(), !equal(left, primary());
    return left;
  }
  function and(): Json {
    let value = comparison();
    while (peek() === "&&") {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  }
  function or(): Json {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  }
  const result = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in ${expression}`);
  return result;
}


describe("GitHub is the sole provider for every contribution", () => {
  const events = {
    "fork pull request": pullRequest("odysseus/brain-kit"),
    "deleted fork pull request": pullRequest(null),
    "same-repository pull request": pullRequest(REPO),
    "differently cased same-repository PR": pullRequest("Schlessera/Brain-Kit"),
    "push to main": { event_name: "push", repository: REPO, event: {} },
    "retired Depot api event": { event_name: "api", repository: REPO, event: {} },
  };
  for (const { file, workflow } of workflows) for (const [label, context] of Object.entries(events)) {
    test(`${file}: ${label} selects all intended jobs`, () => {
      expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
      const expected = label !== "retired Depot api event" && (file === "ci.yml" || label !== "push to main");
      for (const [id, job] of Object.entries(workflow.jobs)) expect({ id, runs: runs(workflow, job, context) }).toEqual({ id, runs: expected });
    });
  }
  test("no duplicate provider definitions or fallback workflows remain", () => { expect(checkCIWorkflows(ROOT)).toEqual([]); });
  test("Pages publication preserves read-only builds and checked artifact ordering", () => {
    const pages = read("publish-pages.yml");
    expect(publicationWorkflowProblems(pages)).toEqual([]);
    const elevated = Bun.YAML.parse(pages) as Workflow;
    elevated.jobs.artifact!.permissions = { pages: "write" };
    expect(publicationWorkflowProblems(Bun.YAML.stringify(elevated))).toContain("publish-pages.yml: artifact job must inherit read-only permissions");
    const premature = Bun.YAML.parse(pages) as Workflow;
    const steps = premature.jobs.artifact!.steps;
    const upload = steps.findIndex(step => step.uses === "actions/upload-pages-artifact@v4");
    expect(upload).toBeGreaterThan(0);
    steps.unshift(...steps.splice(upload, 1));
    expect(publicationWorkflowProblems(Bun.YAML.stringify(premature))).toContain("publish-pages.yml: browser and identity checks must precede Pages artifact upload");
  });
  test("the evaluator refuses unsupported routing rather than defaulting", () => { expect(() => evaluate("github.x ~ 'y'", {})).toThrow(); });
});

describe("the authoritative jobs retain their important phases", () => {
  test("CI events, jobs, runtime pins, planner outputs and fast verification remain", () => {
    expect(ci.name).toBe("CI");
    expect(ci.on.push).toEqual({ branches: ["main"] });
    expect(ci.on.pull_request).toEqual({ types: ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"] });
    expect(Object.keys(ci.jobs)).toEqual(["changeset", "verify", "pack", "unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance", "proof"]);
    expect(ci.jobs.changeset!.outputs).toEqual({ ...Object.fromEntries(["verify", "pack", "unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance", "cadence", "unit_shards"].map(name => [name, `\${{ steps.plan.outputs.${name} }}`])),
      ...Object.fromEntries(["run_browser", "run_layout", "reuse"].map(name => [name, `\${{ steps.reuse.outputs.${name} }}`])) });
    const metadata = ci.jobs.changeset!.steps.filter(s => s.run).map(s => s.run);
    expect(metadata).toContain("bun scripts/ci-plan.ts"); expect(metadata).toContain("bun run lint");
    expect(metadata).toContain("bun scripts/env-docs.ts --check"); expect(metadata).toContain("bun scripts/check-changeset-packages.ts");
    expect(ci.jobs.verify!.steps.filter(s => s.run).map(s => s.run)).toContain("bun scripts/ci-runner.ts");
    for (const [name,job] of Object.entries(ci.jobs)) {
      const bun = job.steps.find(s => s.uses === "oven-sh/setup-bun@v2");
      expect(bun?.with?.["bun-version"]).toBe("1.4.2");
      const install=name==="unit"?"bun install --frozen-lockfile --backend=copyfile":"bun install --frozen-lockfile";
      expect(job.steps.some(s => s.run === install)).toBe(true);
    }
    expect(ci.jobs.changeset!["timeout-minutes"]).toBe(3);
    expect(ci.jobs.verify!["timeout-minutes"]).toBe(3);
    expect(ci.jobs.pack!["timeout-minutes"]).toBe(5);
    // Browser shards keep buffer above the measured ~900 s whole-job peak (#2414).
    expect(ci.jobs.browser!["timeout-minutes"]).toBe(20);
  });
  test("the contract checks exact PR heads and carries title/labels as environment data", () => {
    const contract = workflows.find(w => w.file === "contract.yml")!.workflow;
    expect(contract.on.pull_request).toEqual({ types: ["opened", "edited", "synchronize", "reopened", "labeled", "unlabeled"] });
    const job = contract.jobs.contract!;
    const checkout = job.steps.find(s => s.uses === "actions/checkout@v7");
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const command = job.steps.find(s => s.run)!;
    expect(command.run).toBe('bun scripts/check-contract-pr.ts --declared-base "$HEAD_SHA"');
    expect(command.env?.PR_NUMBER).toBe("${{ github.event.pull_request.number }}");
    expect(command.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(command.env?.PR_TITLE).toBe("${{ github.event.pull_request.title }}");
    expect(command.env?.PR_LABELS).toBe("${{ toJSON(github.event.pull_request.labels.*.name) }}");
  });
});

describe("runtime environment setup and proof budgets", () => {
  for (const [name, proofMinutes] of [["unit", 30], ["runtime", 15], ["runtime_host", 15]] as const) {
    const job = ci.jobs[name]!;
    const setup = job.steps.find(s => s.run === `bash scripts/ci-runtime-setup.sh${name === "unit" ? "" : " --native"}`)!;
    const proof = job.steps.find(s => s.run === `bun scripts/ci-proof.ts ${name}` || s.run?.startsWith(`bun scripts/ci-proof.ts ${name} `))!;
    test(`${name} retains a full proof budget after bounded environment setup`, () => {
      expect(setup["timeout-minutes"]).toBe(12);
      expect(proof["timeout-minutes"]).toBe(proofMinutes);
      expect(job["timeout-minutes"]).toBe(12 + proofMinutes + 3);
      expect(setup.if).toBeUndefined();
      expect(proof.if).toBeUndefined();
      expect(setup["continue-on-error"]).toBeUndefined();
      expect(proof["continue-on-error"]).toBeUndefined();
      expect(job.steps.indexOf(proof)).toBeGreaterThan(job.steps.indexOf(setup));
    });
    test(`${name} workflow guard rejects missing setup bounds, changed proof bounds and a shared job cap`, () => {
      const source = read("ci.yml");
      const mutate = (change: (job: Job) => void) => {
        const workflow = Bun.YAML.parse(source) as Workflow;
        change(workflow.jobs[name]!);
        return workflowProblems(Bun.YAML.stringify(workflow), "ci.yml");
      };
      expect(workflowProblems(source, "ci.yml")).toEqual([]);
      expect(mutate(j => { delete j.steps.find(s => s.run === setup.run)!["timeout-minutes"]; }))
        .toContain(`ci.yml: ${name}: environment setup must have its separate 12-minute limit`);
      for (const limit of [undefined, proofMinutes - 1, proofMinutes + 1]) {
        expect(mutate(j => { j.steps.find(s => s.run === proof.run)!["timeout-minutes"] = limit ?? null; }))
          .toContain(`ci.yml: ${name}: proof must retain its ${proofMinutes}-minute limit`);
      }
      expect(mutate(j => { j["timeout-minutes"] = proofMinutes; }))
        .toContain(`ci.yml: ${name}: job limit must cover setup, proof and 3 minutes of other steps`);
    });
    test(`${name} summary distinguishes setup infrastructure failure from proof failure`, () => {
      const summary = job.steps.find(s => s.name === "Environment setup and proof outcomes")!;
      expect(summary).toBeDefined();
      expect(summary.if).toBe("always()");
      expect(summary.env).toEqual({
        SETUP_OUTCOME: "${{ steps.runtime_setup.outcome }}",
        PROOF_OUTCOME: "${{ steps.runtime_proof.outcome }}",
      });
      expect(setup.id).toBe("runtime_setup");
      expect(proof.id).toBe("runtime_proof");
      expect(job.steps.indexOf(summary)).toBeGreaterThan(job.steps.indexOf(proof));
      const dir = mkdtempSync(join(tmpdir(), "ci-phase-outcomes-"));
      try {
        for (const [setupOutcome, proofOutcome] of [["failure", "skipped"], ["cancelled", "skipped"], ["success", "failure"], ["success", "success"]]) {
          const output = join(dir, "summary.md");
          writeFileSync(output, "");
          const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", summary.run!], {
            env: { ...process.env, GITHUB_STEP_SUMMARY: output, SETUP_OUTCOME: setupOutcome!, PROOF_OUTCOME: proofOutcome! },
            stdout: "pipe", stderr: "pipe",
          });
          expect(result.exitCode).toBe(0);
          expect(readFileSync(output, "utf8")).toBe(
            `Environment setup (infrastructure prerequisite, 12-minute limit): ${setupOutcome}\nProof (${proofMinutes}-minute limit): ${proofOutcome}\n`,
          );
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe("CI concurrency configuration (live scheduler proof remains separate)", () => {
  const push = (sha: string): Obj => ({ event_name: "push", ref: "refs/heads/main", sha });
  const pr = (number: number, sha: string): Obj => ({ event_name: "pull_request", ref: `refs/pull/${number}/merge`, sha });
  const key = (event: Obj) => String((ci.concurrency as Obj).group).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g,
    (_, expression: string) => String(evaluate(expression, { github: { ...event, workflow: ci.name } })));
  test("the evaluator preserves selected string values", () => {
    expect(evaluate("github.event_name == 'pull_request' && github.ref || github.sha", { github: push("a".repeat(40)) })).toBe("a".repeat(40));
    expect(evaluate("github.event_name == 'pull_request' && github.ref || github.sha", { github: pr(7, "b".repeat(40)) })).toBe("refs/pull/7/merge");
  });
  test("main commits cannot replace one another's pending group", () => { expect(key(push("a".repeat(40)))).not.toBe(key(push("b".repeat(40)))); });
  test("superseded heads of one PR share a group, distinct PRs do not", () => {
    const first = key(pr(7, "a".repeat(40))); expect(first).toBe(key(pr(7, "b".repeat(40))));
    expect(first).not.toBe(key(pr(8, "a".repeat(40)))); expect(first).not.toBe(key(push("a".repeat(40))));
  });
  test("only superseded PR executions cancel running work", () => {
    const expression = String((ci.concurrency as Obj)["cancel-in-progress"]).replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    expect(evaluate(expression, { github: push("a".repeat(40)) })).toBe(false);
    expect(evaluate(expression, { github: pr(7, "a".repeat(40)) })).toBe(true);
  });
});

describe("independent hosted proof after cheap gates", () => {
  const context = (selected = "true", result = "success", execute = "true") => ({ needs: { changeset: { result, outputs: { verify: selected, pack: selected, unit: selected, runtime: selected, runtime_host: selected, browser: selected, layout: selected, captures: selected, endurance: selected, run_browser: execute, run_layout: execute } } } });
  test("all independent categories depend only on metadata", () => {
    for (const name of ["verify", "pack", "unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"]) {
      expect(ci.jobs[name]!.needs).toBe("changeset");
      expect(evaluate(ci.jobs[name]!.if!, context())).toBe(true);
      expect(evaluate(ci.jobs[name]!.if!, context("false"))).toBe(false);
    }
  });
  test("the aggregate observes every category even after an intentional skip or failed prerequisite", () => {
    expect(ci.jobs.proof!.needs).toEqual(["changeset", "verify", "pack", "unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"]);
    expect(ci.jobs.proof!.if).toContain("always()");
    expect(evaluate(ci.jobs.proof!.if!, { cancelled: false })).toBe(true);
    expect(evaluate(ci.jobs.proof!.if!, { cancelled: true })).toBe(false);
  });
  test("draft or unaffected selections skip dependent jobs for forks and same-repository PRs", () => {
    for (const repo of [REPO, "odysseus/brain-kit"]) {
      const c = { github: pullRequest(repo), ...context("false") };
      expect(ci.jobs.changeset!.if).toBeUndefined();
      for (const name of ["verify", "pack", "unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"]) expect(evaluate(ci.jobs[name]!.if!, c)).toBe(false);
    }
  });
  test("retention skips only admitted browser categories; other selected proof remains fresh", () => {
    for (const name of ["browser", "layout"]) expect(evaluate(ci.jobs[name]!.if!, context("true", "success", "false"))).toBe(false);
    for (const name of ["unit", "verify", "pack", "runtime", "runtime_host", "captures"]) expect(evaluate(ci.jobs[name]!.if!, context("true", "success", "false"))).toBe(true);
  });
});

describe("contributions execute without privileged credentials", () => {
  for (const { file, workflow } of workflows) {
    test(`${file}: no secret, write permission or privileged trigger`, () => {
      expect(read(file)).not.toMatch(/\bsecrets\.|pull_request_target|workflow_run|id-token|: write\b/);
      expect(workflow.permissions).toEqual(file === "ci.yml" ? { contents: "read", actions: "read", checks: "read" } : { contents: "read" });
      for (const job of Object.values(workflow.jobs)) {
        expect(job.permissions).toBeUndefined(); expect(job["runs-on"]).toBe("ubuntu-24.04");
        const checkouts = job.steps.filter(s => s.uses?.startsWith("actions/checkout@"));
        expect(checkouts.length).toBeGreaterThan(0);
        for (const step of checkouts) expect(step.with?.["persist-credentials"]).toBe(false);
      }
    });
    test(`${file}: run scripts interpolate no fork-controlled value`, () => {
      const allowed = new Set(["matrix.shard", "github.event_name", "github.base_ref", "github.event.before"]);
      for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
        for (const match of (step.run ?? "").matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) expect([match[1], allowed.has(match[1]!)]).toEqual([match[1], true]);
      }
    });
  }
});

/**
 * The installed contract step, executed the way the runner executes it: its
 * env expressions substituted from an event context, then `bash -e`. The PR
 * lookup is a loopback server; the fixture repository has the remote-tracking
 * refs a full-history checkout fetches.
 */
describe("the contract gate compares each PR with the base it declares (#2650)", () => {
  const contract = workflows.find(w => w.file === "contract.yml")!.workflow;
  const types = (contract.on.pull_request as Obj).types as string[];
  const step = Object.values(contract.jobs).flatMap((job) => job.steps).filter((s) => s.run);
  const COMPONENT = "docs/integration-contract/http.md";
  const OWN = "docs/integration-contract/wire.md";
  const LOWER = "feat/1665-lower";
  let repo = "";
  let heads: Record<"trunk" | "lower" | "upper" | "upperOwn", string>;
  let pulls: Record<string, { status: number; body?: Json }> = {};
  let server: ReturnType<typeof Bun.serve>;

  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  const write = (file: string, text: string) => { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), text); };
  const commit = (message: string) => { git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  const pull = (number: number, base: string, head: string, baseRepo = REPO): Obj => ({ number, base: { ref: base, repo: { full_name: baseRepo } }, head: { sha: head } });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "contract-declared-base-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "odysseus@example.com");
    git("config", "user.name", "Odysseus");
    write("scripts/check-contract-pr.ts", readFileSync(join(ROOT, "scripts/check-contract-pr.ts"), "utf8"));
    write("docs/integration-contract.md", "Index\n");
    write(COMPONENT, "Ithaca harbour v1\n");
    write(OWN, "Wire v1\n");
    const trunk = commit("trunk");
    git("checkout", "-qb", LOWER);
    write(COMPONENT, "Ithaca harbour v2\n");
    const lower = commit("lower layer changes the HTTP contract");
    git("checkout", "-qb", "upper");
    write("packages/core/src/voyage.ts", "export const leg = 2;\n");
    const upper = commit("upper layer changes code only");
    git("checkout", "-qb", "upper-own", lower);
    write(OWN, "Wire v2\n");
    const upperOwn = commit("upper layer changes its own contract");
    git("update-ref", "refs/remotes/origin/main", trunk);
    git("update-ref", `refs/remotes/origin/${LOWER}`, lower);
    heads = { trunk, lower, upper, upperOwn };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const match = new URL(request.url).pathname.match(/^\/repos\/schlessera\/brain-kit\/pulls\/(\d+)$/);
      const answer = match && request.headers.get("authorization") === "Bearer offline-fixture-token" ? pulls[match[1]!] : undefined;
      return answer ? Response.json(answer.body ?? { message: "refused" }, { status: answer.status }) : Response.json({ message: "Not Found" }, { status: 404 });
    } });
  });
  afterAll(() => { server?.stop(true); if (repo) rmSync(repo, { recursive: true, force: true }); });

  /** The step's exit code and output for one event context. */
  async function gate(event: { action: string; base_ref: string; number?: number; head: string; title: string; labels?: string[]; headRepo?: string }) {
    expect(step.length).toBe(1);
    const context: Obj = {
      event_name: "pull_request", repository: REPO, base_ref: event.base_ref, token: "offline-fixture-token",
      event: { action: event.action, pull_request: { ...(event.number === undefined ? {} : { number: event.number }), title: event.title,
        labels: (event.labels ?? []).map(name => ({ name })), head: { sha: event.head, repo: { full_name: event.headRepo ?? REPO } } } },
    };
    const valueOf = (expression: string): string => {
      const pr = (context.event as Obj).pull_request as Obj;
      if (/^toJSON\(github\.event\.pull_request\.labels\.\*\.name\)$/.test(expression)) return JSON.stringify((pr.labels as Obj[]).map((l) => l.name));
      const value = evaluateValue(expression, { github: context });
      if (value === null) return ""; // The runner renders a missing property as empty.
      if (typeof value !== "string" && typeof value !== "number") throw new Error(`no value for ${expression}`);
      return String(value);
    };
    const substitute = (text: string) => text.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, e: string) => valueOf(e));
    const env: Record<string, string> = {};
    for (const [key, raw] of Object.entries(step[0]!.env ?? {})) env[key] = substitute(String(raw));
    // Async: a synchronous spawn would block the loopback server it calls.
    const child = Bun.spawn(["bash", "-e", "-c", substitute(step[0]!.run!)], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...env, GITHUB_REPOSITORY: REPO, GITHUB_API_URL: server.url.href, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr, env };
  }

  test("every trigger of an upper layer diffs against its parent, even when the event names main", async () => {
    pulls = { 12: { status: 200, body: pull(12, LOWER, heads.upper) } };
    expect(types).toEqual(["opened", "edited", "synchronize", "reopened", "labeled", "unlabeled"]);
    for (const action of types) for (const base_ref of ["main", LOWER]) {
      const result = await gate({ action, base_ref, number: 12, head: heads.upper, title: "feat(core): chart the next leg" });
      expect({ action, base_ref, exit: result.exit, stderr: result.stderr }).toEqual({ action, base_ref, exit: 0, stderr: "" });
      expect(result.stdout).toContain(`Contract base: origin/${LOWER}, declared by PR #12`);
      expect(result.stdout).toContain("not a contract change");
    }
  });

  test("an upper layer's own contract edit still needs its title and label", async () => {
    pulls = { 13: { status: 200, body: pull(13, LOWER, heads.upperOwn) } };
    const plain = await gate({ action: "edited", base_ref: "main", number: 13, head: heads.upperOwn, title: "feat(core): chart the next leg" });
    expect(plain.exit).toBe(1);
    expect(plain.stderr).toContain(`${OWN} changed, but the title does not start with \`CONTRACT:\`.`);
    expect(plain.stderr).not.toContain(COMPONENT);
    const marked = await gate({ action: "labeled", base_ref: "main", number: 13, head: heads.upperOwn, title: "CONTRACT: feat(core): chart the next leg", labels: ["contract"] });
    expect([marked.exit, marked.stdout]).toEqual([0, expect.stringContaining("Contract change")]);
  });

  test("an ordinary PR against main is judged as before", async () => {
    pulls = { 14: { status: 200, body: pull(14, "main", heads.lower) } };
    const plain = await gate({ action: "opened", base_ref: "main", number: 14, head: heads.lower, title: "feat(core): widen the harbour" });
    expect(plain.exit).toBe(1);
    expect(plain.stderr).toContain(`${COMPONENT} changed, but the title does not start with \`CONTRACT:\`.`);
    expect(plain.stdout).toContain("Contract base: origin/main, declared by PR #14; the event agrees.");
    const marked = await gate({ action: "edited", base_ref: "main", number: 14, head: heads.lower, title: "CONTRACT: feat(core): widen the harbour", labels: ["contract"] });
    expect(marked.exit).toBe(0);
  });

  test("an unreadable or unfetched declared base fails the gate instead of choosing main", async () => {
    pulls = {
      15: { status: 200, body: pull(15, "feat/1665-unfetched", heads.upper) },
      16: { status: 200, body: pull(16, LOWER, heads.upper, "odysseus/brain-kit") },
      17: { status: 200, body: pull(18, LOWER, heads.upper) },
    };
    const cases: [number | undefined, string][] = [
      [undefined, "PR_NUMBER is not a pull request number"],
      [404, "Reading PR #404 failed: HTTP 404"],
      [15, "PR #15 declares base feat/1665-unfetched, but the checkout has not fetched origin/feat/1665-unfetched"],
      [16, "PR #16 declares a base outside schlessera/brain-kit"],
      [17, "The lookup for PR #17 did not return that pull request"],
    ];
    for (const [number, diagnostic] of cases) {
      const result = await gate({ action: "edited", base_ref: "main", number, head: heads.upper, title: "feat(core): chart the next leg" });
      expect({ number, exit: result.exit, diagnostic: result.stderr.includes(diagnostic) }).toEqual({ number, exit: 2, diagnostic: true });
      expect(result.stdout).not.toContain("Contract base");
    }
  });

  test("a fork's hostile title stays inert in the emitted contract step", async () => {
    const sentinel = join(repo, "pwned");
    pulls = { 7: { status: 200, body: pull(7, "main", heads.trunk) } };
    const result = await gate({ action: "opened", base_ref: "main", number: 7, head: heads.trunk, headRepo: "odysseus/brain-kit",
      title: `CONTRACT: feat(core): $(touch ${sentinel}) \`touch ${sentinel}\``, labels: ["contract", `$(touch ${sentinel})`] });
    expect(result.env.PR_TITLE).toContain("$(touch");
    // Nothing in the title or labels was executed.
    expect(existsSync(sentinel)).toBe(false);
    // They were read, judged and rejected as text: the title claims a
    // contract change the empty diff does not make.
    expect(result.stderr).toContain("The title starts with `CONTRACT:`, but docs/integration-contract.md and its authoritative components did not change.");
    expect(result.exit).toBe(1);
  });
});

/** A property path's value, for building step env the way the runner does. */
function evaluateValue(path: string, context: Obj): Json {
  let value: Json = context;
  for (const part of path.split(".")) {
    value = value !== null && typeof value === "object" && !Array.isArray(value) ? (value[part] ?? null) : null;
  }
  return value;
}


describe("the workflow lint refuses unsafe or duplicate execution shapes", () => {
  const original = read("ci.yml");
  test("a valid authoritative workflow passes", () => { expect(workflowProblems(original, "ci.yml")).toEqual([]); });
  test("duplicate top-level YAML keys cannot hide a malformed workflow", () => {
    expect(workflowProblems(`name: CI\n${original}`, "ci.yml")).toContain("ci.yml: duplicate top-level key name");
  });
  test("an unmapped runner is rejected", () => { expect(workflowProblems(original.replaceAll("ubuntu-24.04", "depot-ubuntu-24.04"), "ci.yml")).toContain("ci.yml: changeset: unmapped GitHub-hosted runner"); });
  test("provider routing cannot omit forks", () => {
    const bad = original.replace("  changeset:\n", "  changeset:\n    if: github.event.pull_request.head.repo.full_name == github.repository\n");
    expect(workflowProblems(bad, "ci.yml")).toContain("ci.yml: changeset: provider routing must not exclude contributions");
  });
  test("unexpected triggers fail", () => { expect(workflowProblems(original.replace("on:\n", "on:\n  release:\n"), "ci.yml")).toContain("ci.yml: unexpected contribution triggers"); });
  test("secrets and privileged triggers fail", () => {
    expect(workflowProblems(original.replace("bun run lint", "echo ${{ secrets.NPM_TOKEN }}"), "ci.yml")).toContain("ci.yml: CI must not expose secrets or privileged triggers");
    expect(workflowProblems(original.replace("pull_request:", "pull_request_target:"), "ci.yml")).toContain("ci.yml: CI must not expose secrets or privileged triggers");
  });
  test("persisted checkout credentials fail", () => { expect(workflowProblems(original.replaceAll("persist-credentials: false", "persist-credentials: true"), "ci.yml")).toContain("ci.yml: changeset: checkout credentials must not persist"); });
  test("fork-controlled run interpolation fails", () => { expect(workflowProblems(original.replace("bun run lint", "echo ${{ github.event.pull_request.title }}"), "ci.yml")).toContain("ci.yml: changeset: untrusted expression in run script: github.event.pull_request.title"); });
  test("missing jobs and empty phases fail", () => {
    const obj = Bun.YAML.parse(original) as Workflow; delete obj.jobs.verify;
    expect(workflowProblems(Bun.YAML.stringify(obj), "ci.yml")).toContain("ci.yml: missing or unexpected CI jobs");
    obj.jobs.changeset.steps=[];
    expect(workflowProblems(Bun.YAML.stringify(obj), "ci.yml")).toContain("ci.yml: changeset: executable steps must be nonempty");
  });
  test("invalid YAML and a missing authoritative file cannot pass", () => {
    expect(workflowProblems("jobs: [", "ci.yml")).toEqual(["ci.yml: invalid YAML"]);
    const dir=mkdtempSync(join(tmpdir(),"ci-workflow-"));
    try { expect(checkCIWorkflows(dir)).toContain("ci.yml: missing authoritative GitHub workflow"); } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test("the contract gate cannot take its base from the event (#2650)", () => {
    const contract = read("contract.yml");
    expect(workflowProblems(contract, "contract.yml")).toEqual([]);
    const problem = "contract.yml: contract: the comparison base must be the PR's declared base, read at run time, never the event's";
    const eventBase = contract
      .replace("          EVENT_BASE_REF: ${{ github.base_ref }}\n", "          BASE_REF: origin/${{ github.base_ref }}\n")
      .replace('--declared-base "$HEAD_SHA"', '"$BASE_REF" "$HEAD_SHA"');
    expect(workflowProblems(eventBase, "contract.yml")).toContain(problem);
    expect(workflowProblems(contract.replace("          EVENT_BASE_REF:", "          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n          EVENT_BASE_REF:"), "contract.yml")).toContain(problem);
    expect(workflowProblems(contract.replace("          PR_NUMBER: ${{ github.event.pull_request.number }}\n", ""), "contract.yml")).toContain(problem);
    expect(workflowProblems(contract.replace("          GH_TOKEN: ${{ github.token }}\n", ""), "contract.yml")).toContain(problem);
  });
  test("an active Depot definition cannot coexist with GitHub CI", () => {
    const dir=mkdtempSync(join(tmpdir(),"ci-workflow-"));
    try {
      mkdirSync(join(dir,".github/workflows"),{recursive:true}); mkdirSync(join(dir,".depot/workflows"),{recursive:true});
      for(const file of CI_WORKFLOWS) writeFileSync(join(dir,".github/workflows",file),read(file));
      writeFileSync(join(dir,".github/workflows/project-sync.yml"),"");
      writeFileSync(join(dir,".depot/workflows/ci.yml"),original);
      expect(checkCIWorkflows(dir)).toContain("Active Depot CI workflow definitions must be removed");
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});


test("independent verification starts after metadata without waiting for packaging", () => {
  expect(ci.jobs.verify!.needs).toBe("changeset");
});


test("workflow guard rejects an omitted complete proof command and aggregate prerequisite", () => {
  const original = read("ci.yml");
  expect(workflowProblems(original.replace("bun scripts/ci-proof.ts runtime", "echo omitted"), "ci.yml")).toContain("ci.yml: runtime: complete proof command is missing");
  const workflow = Bun.YAML.parse(original) as Workflow;
  workflow.jobs.proof!.needs = ["changeset", "verify", "pack"];
  expect(workflowProblems(Bun.YAML.stringify(workflow), "ci.yml")).toContain("ci.yml: proof: aggregate must observe every selected category");
});


test("workflow cannot check out a different tree or impersonate candidate proof from draft or manual runs", () => {
  const text = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  expect(workflowProblems(text.replace("persist-credentials: false", "persist-credentials: false\n          ref: main"), "ci.yml").join("\n")).toContain("proof checkout must use the event candidate");
  expect(workflowProblems(text.replace("name: ${{ github.event_name != 'pull_request' && 'integrated or exhaustive proof' || github.event.pull_request.draft && 'draft gates' || 'proof' }}", "name: proof"), "ci.yml").join("\n")).toContain("must not impersonate candidate confirmation");
  // A draft run's aggregate keeps a distinct name, so its cheap success never stands as a ready PR's proof (#2363).
  expect(workflowProblems(text.replace("github.event.pull_request.draft && 'draft gates' || ", ""), "ci.yml").join("\n")).toContain("must not impersonate candidate confirmation");
});

test("browser and layout matrices match the shared shard table (#2414)", () => {
  const text = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  expect(workflowProblems(text, "ci.yml")).toEqual([]);
  expect(workflowProblems(text.replace("shard: [1, 2, 3]", "shard: [1, 2]"), "ci.yml").join("\n")).toContain("browser: matrix and shard divisor must match PROOF_SHARDS");
  expect(workflowProblems(text.replace("browser --shard=${{ matrix.shard }}/3", "browser --shard=${{ matrix.shard }}/2"), "ci.yml").join("\n")).toContain("browser: matrix and shard divisor must match PROOF_SHARDS");
  expect(workflowProblems(text.replace("layout --shard=${{ matrix.shard }}/2", "layout --shard=${{ matrix.shard }}/3"), "ci.yml").join("\n")).toContain("layout: matrix and shard divisor must match PROOF_SHARDS");
  const layoutMatrix = text.indexOf("shard: [1, 2]\n", text.indexOf("  layout:\n"));
  expect(layoutMatrix).toBeGreaterThan(0);
  expect(workflowProblems(text.slice(0, layoutMatrix) + "shard: [1, 2, 3]\n" + text.slice(layoutMatrix + "shard: [1, 2]\n".length), "ci.yml").join("\n")).toContain("layout: matrix and shard divisor must match PROOF_SHARDS");
});

test("small exact inventories wire bounded planner partitions into actual unit execution", () => {
  expect(ci.jobs.unit!.strategy).toEqual({"fail-fast": false, matrix: {shard: "${{ fromJSON(needs.changeset.outputs.unit_shards) }}"}});
  const step = ci.jobs.unit!.steps.find(s => s.name === "Complete unit proof")!;
  expect(step.env?.UNIT_SHARDS).toBe("${{ strategy.job-total }}");
  expect(step.run).toBe('bun scripts/ci-proof.ts unit --shard=${{ matrix.shard }}/"$UNIT_SHARDS"');
});


test("runtime categories have distinct complete commands and strict aggregate dependencies", () => {
  const original = read("ci.yml");
  expect(workflowProblems(original.replace("run: bun scripts/ci-proof.ts runtime\n", "run: bun scripts/ci-proof.ts runtime_host\n"), "ci.yml")).toContain("ci.yml: runtime: complete proof command is missing");
  expect(workflowProblems(original.replace("run: bun scripts/ci-proof.ts runtime_host\n", "run: echo omitted\n"), "ci.yml")).toContain("ci.yml: runtime_host: complete proof command is missing");
  expect(workflowProblems(original.replace("unit, runtime, runtime_host, browser", "unit, runtime, browser"), "ci.yml")).toContain("ci.yml: proof: aggregate must observe every selected category");
});
