/** Preserve contribution routing, scheduling and hostile-metadata proof on GitHub Actions. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CI_WORKFLOWS, checkCIWorkflows, workflowProblems } from "../scripts/check-ci-workflows.ts";
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
const pullRequest = (headRepo: string | null, extra: Obj = {}): Obj => ({
  event_name: "pull_request", repository: REPO,
  event: { pull_request: { number: 7, title: "fix(core): steer between Scylla and Charybdis", labels: [],
    head: { sha: "1".repeat(40), repo: headRepo === null ? null : { full_name: headRepo } }, ...extra } },
});
function runs(workflow: Workflow, job: Job, context: Obj): boolean {
  return String(context.event_name) in workflow.on && (job.if === undefined || evaluate(job.if, {
    github: context, needs: { changeset: { result: "success", outputs: { verify: "true", pack: "true" } }, pack: { result: "success" } },
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
    if (token === "cancelled" && peek() === "(") {
      take();
      if (take() !== ")") throw new Error(`cancelled takes no arguments in ${expression}`);
      return context.cancelled === true;
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
  test("the evaluator refuses unsupported routing rather than defaulting", () => { expect(() => evaluate("github.x ~ 'y'", {})).toThrow(); });
});

describe("the authoritative jobs retain their important phases", () => {
  test("CI events, jobs, runtime pins, planner outputs and fast verification remain", () => {
    expect(ci.name).toBe("CI");
    expect(ci.on.push).toEqual({ branches: ["main"] });
    expect(ci.on.pull_request).toEqual({ types: ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"] });
    expect(Object.keys(ci.jobs)).toEqual(["changeset", "verify", "pack"]);
    expect(ci.jobs.changeset!.outputs).toEqual({ verify: "${{ steps.plan.outputs.verify }}", pack: "${{ steps.plan.outputs.pack }}" });
    const metadata = ci.jobs.changeset!.steps.filter(s => s.run).map(s => s.run);
    expect(metadata).toContain("bun scripts/ci-plan.ts"); expect(metadata).toContain("bun run lint");
    expect(metadata).toContain("bun scripts/env-docs.ts --check"); expect(metadata).toContain("bun scripts/check-changeset-packages.ts");
    expect(ci.jobs.verify!.steps.filter(s => s.run).map(s => s.run)).toContain("bun scripts/ci-runner.ts");
    for (const job of Object.values(ci.jobs)) {
      const bun = job.steps.find(s => s.uses === "oven-sh/setup-bun@v2");
      expect(bun?.with?.["bun-version"]).toBe("1.4.2");
      expect(job.steps.some(s => s.run === "bun install --frozen-lockfile")).toBe(true);
    }
    expect(ci.jobs.changeset!["timeout-minutes"]).toBe(3);
    expect(ci.jobs.verify!["timeout-minutes"]).toBe(3);
    expect(ci.jobs.pack!["timeout-minutes"]).toBe(5);
  });
  test("the contract checks exact PR heads and carries title/labels as environment data", () => {
    const contract = workflows.find(w => w.file === "contract.yml")!.workflow;
    expect(contract.on.pull_request).toEqual({ types: ["opened", "edited", "synchronize", "reopened", "labeled", "unlabeled"] });
    const job = contract.jobs.contract!;
    const checkout = job.steps.find(s => s.uses === "actions/checkout@v7");
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const command = job.steps.find(s => s.run)!;
    expect(command.run).toBe('bun scripts/check-contract-pr.ts "$BASE_REF" "$HEAD_SHA"');
    expect(command.env?.PR_TITLE).toBe("${{ github.event.pull_request.title }}");
    expect(command.env?.PR_LABELS).toBe("${{ toJSON(github.event.pull_request.labels.*.name) }}");
  });
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

describe("longer packaging completes before short verification", () => {
  const selected = (pack: string, result: string, cancelled = false, verify = "true", changeset = "success") => ({
    github: pullRequest(REPO), cancelled, needs: { changeset: { result: changeset, outputs: { verify, pack } }, pack: { result } },
  });
  test("the dependency prevents verification starting beside packaging", () => {
    expect(ci.jobs.pack!.needs).toBe("changeset"); expect(ci.jobs.verify!.needs).toEqual(["changeset", "pack"]);
    for (const state of ["", "queued", "in_progress"]) expect(evaluate(ci.jobs.verify!.if!, selected("true", state))).toBe(false);
    expect(evaluate(ci.jobs.verify!.if!, selected("true", "success"))).toBe(true);
  });
  test("an intentional pack skip still permits selected verification", () => {
    expect(ci.jobs.verify!.if).toContain("!cancelled()");
    expect(evaluate(ci.jobs.verify!.if!, selected("false", "skipped"))).toBe(true);
    expect(evaluate(ci.jobs.verify!.if!, selected("true", "skipped"))).toBe(false);
  });
  test("failure, cancellation and unselected checks never trigger downstream work", () => {
    for (const result of ["failure", "cancelled"]) expect(evaluate(ci.jobs.verify!.if!, selected("true", result))).toBe(false);
    expect(evaluate(ci.jobs.verify!.if!, selected("true", "success", true))).toBe(false);
    expect(evaluate(ci.jobs.verify!.if!, selected("false", "skipped", true))).toBe(false);
    expect(evaluate(ci.jobs.verify!.if!, selected("false", "skipped", false, "false"))).toBe(false);
    for (const state of ["failure", "cancelled", "skipped"]) expect(evaluate(ci.jobs.verify!.if!, selected("false", "skipped", false, "true", state))).toBe(false);
  });
  test("draft or unaffected selections skip dependent jobs for forks and same-repository PRs", () => {
    for (const repo of [REPO, "odysseus/brain-kit"]) {
      const context = { github: pullRequest(repo), needs: { changeset: { result: "success", outputs: { verify: "false", pack: "false" } }, pack: { result: "skipped" } } };
      expect(ci.jobs.changeset!.if).toBeUndefined();
      expect(evaluate(ci.jobs.verify!.if!, context)).toBe(false); expect(evaluate(ci.jobs.pack!.if!, context)).toBe(false);
    }
  });
});

describe("contributions execute without privileged credentials", () => {
  for (const { file, workflow } of workflows) {
    test(`${file}: no secret, write permission or privileged trigger`, () => {
      expect(read(file)).not.toMatch(/\bsecrets\.|pull_request_target|workflow_run|id-token|: write\b/);
      expect(workflow.permissions).toEqual({ contents: "read" });
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
  test("a fork's hostile title stays inert in the emitted contract step", () => {
    const adapter = workflows.find(w => w.file === "contract.yml")!.workflow;
    const steps = Object.values(adapter.jobs).flatMap((job) => job.steps).filter((step) => step.run);
    expect(steps.length).toBe(1);
    const step = steps[0]!;
    const scratch = mkdtempSync(join(tmpdir(), "fork-contract-"));
    try {
      const sentinel = join(scratch, "pwned");
      const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT });
      expect(head.exitCode).toBe(0);
      const sha = new TextDecoder().decode(head.stdout).trim();
      const context = pullRequest("odysseus/brain-kit", {
        title: `CONTRACT: feat(core): $(touch ${sentinel}) \`touch ${sentinel}\``,
        labels: [{ name: "contract" }, { name: `$(touch ${sentinel})` }],
        head: { sha, repo: { full_name: "odysseus/brain-kit" } },
      });
      // The values the runner would place in the step's env.
      const valueOf = (expression: string): string => {
        const labels = /^toJSON\(github\.event\.pull_request\.labels\.\*\.name\)$/.exec(expression);
        const pr = (context.event as Obj).pull_request as Obj;
        if (labels) return JSON.stringify((pr.labels as Obj[]).map((l) => l.name));
        if (expression === "github.base_ref") return "HEAD";
        const value = evaluateValue(expression, { github: context });
        if (typeof value !== "string") throw new Error(`no value for ${expression}`);
        return value;
      };
      // The runner substitutes expressions in env values and in the script
      // itself before bash sees it.
      const substitute = (text: string) =>
        text.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, e: string) => valueOf(e));
      const env: Record<string, string> = {};
      for (const [key, raw] of Object.entries(step.env ?? {})) env[key] = substitute(String(raw));
      expect(env.PR_TITLE).toContain("$(touch");
      // `origin/HEAD` would need a remote; diff the checkout against itself.
      env.BASE_REF = sha;
      const result = Bun.spawnSync(["bash", "-e", "-c", substitute(step.run!)], {
        cwd: ROOT,
        env: { ...process.env, ...env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
      });
      // Nothing in the title or labels was executed.
      expect(existsSync(sentinel)).toBe(false);
      // They were read, judged and rejected as text: the title claims a
      // contract change the empty diff does not make.
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).toContain("The title starts with `CONTRACT:`, but docs/integration-contract.md did not change.");
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
  test("unexpected triggers fail", () => { expect(workflowProblems(original.replace("on:\n", "on:\n  workflow_dispatch:\n"), "ci.yml")).toContain("ci.yml: unexpected contribution triggers"); });
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
