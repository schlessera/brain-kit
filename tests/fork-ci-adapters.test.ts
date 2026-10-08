/**
 * Fork pull requests run CI on GitHub Actions from adapters generated out of
 * the Depot workflows (#988). These tests hold the adapters to their sources
 * and the two providers to their routes:
 *
 * - the committed adapters are what the generator produces now;
 * - independently of the generator, every source job, step, matrix, setting
 *   and trigger reaches the adapter, and only the enumerated adaptations
 *   differ;
 * - evaluated against real event shapes, exactly one provider runs each job;
 * - a fork's PR title stays an inert value in the adapter's contract step.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  ADAPTERS,
  DEPOT_ROUTE,
  FORK_ROUTE,
  forkJobName,
  generateAdapter,
  RUNNER_MAP,
  WORKFLOW_NAME_SUFFIX,
} from "../scripts/fork-ci-adapters.ts";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
type Step = Obj & { uses?: string; with?: Obj; run?: string; env?: Obj };
type Job = Obj & { steps: Step[]; "runs-on": string; if?: string; name?: string };
type Workflow = Obj & { name: string; on: Obj; jobs: Record<string, Job> };

const parse = (text: string) => Bun.YAML.parse(text) as Workflow;
const isCheckout = (step: Step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@");

const pairs = ADAPTERS.map((spec) => ({
  spec,
  source: parse(read(spec.source)),
  adapter: parse(read(spec.target)),
}));

describe("fork CI adapters are generated from the Depot workflows", () => {
  for (const spec of ADAPTERS) {
    test(`${spec.target} is what the generator produces from ${spec.source}`, () => {
      expect(existsSync(join(ROOT, spec.target))).toBe(true);
      expect(read(spec.target)).toBe(generateAdapter(read(spec.source), spec));
    });
  }

  test("GitHub Actions holds only project sync and the generated fork adapters", () => {
    // A hand-written general CI or contract workflow here would be a second
    // suite that drifts from Depot, or a retired one coming back.
    const files = readdirSync(join(ROOT, ".github/workflows")).sort();
    const expected = ["project-sync.yml", ...ADAPTERS.map((a) => a.target.split("/").pop()!)].sort();
    expect(files).toEqual(expected);
  });
});

describe("an adapter differs from its source only by the enumerated adaptations", () => {
  for (const { spec, source, adapter } of pairs) {
    describe(spec.target, () => {
      test("workflow settings and the pull_request trigger are unchanged; push is dropped", () => {
        expect(adapter.name).toBe(`${source.name}${WORKFLOW_NAME_SUFFIX}`);
        expect(Object.keys(adapter.on)).toEqual(["pull_request"]);
        expect(Object.keys(source.on)).toContain("pull_request");
        expect(adapter.on.pull_request).toEqual(source.on.pull_request ?? null);
        const settings = (w: Workflow) => {
          const { name: _n, on: _o, jobs: _j, ...rest } = w;
          return rest;
        };
        expect(settings(adapter)).toEqual(settings(source));
        expect(source.permissions).toEqual({ contents: "read" });
      });

      test("every source job is present, in order, and nonempty", () => {
        const ids = Object.keys(source.jobs);
        expect(ids.length).toBeGreaterThan(0);
        expect(Object.keys(adapter.jobs)).toEqual(ids);
        for (const id of ids) expect(source.jobs[id]!.steps.length).toBeGreaterThan(0);
      });

      for (const id of Object.keys(source.jobs)) {
        test(`job ${id}: routing, runner and checkout credentials are the only differences`, () => {
          const from = source.jobs[id]!;
          const to = adapter.jobs[id]!;
          expect(from.if === DEPOT_ROUTE || from.if!.startsWith(`(${DEPOT_ROUTE}) && `)).toBe(true);
          expect(to.if).toBe(from.if!.replace(DEPOT_ROUTE, FORK_ROUTE));
          expect(from.name).toBeUndefined();
          expect(to.name).toBe(forkJobName(id));
          expect(RUNNER_MAP[from["runs-on"]]).toBeDefined();
          expect(to["runs-on"]).toBe(RUNNER_MAP[from["runs-on"]]!);
          expect(from.permissions).toBeUndefined();
          expect(to.permissions).toBeUndefined();

          const checkouts = to.steps.filter(isCheckout);
          expect(checkouts.length).toBeGreaterThan(0);
          for (const step of checkouts) expect(step.with?.["persist-credentials"]).toBe(false);
          for (const step of from.steps.filter(isCheckout)) {
            expect(step.with?.["persist-credentials"]).toBeUndefined();
          }

          // Undo the enumerated adaptations; what is left must be identical:
          // every step, command, env, matrix, container, timeout and artifact.
          const undone = structuredClone(to) as Job;
          delete undone.name;
          undone.if = from.if;
          undone["runs-on"] = from["runs-on"];
          for (const step of undone.steps.filter(isCheckout)) {
            delete step.with!["persist-credentials"];
            if (Object.keys(step.with!).length === 0) delete step.with;
          }
          expect(undone).toEqual(from);
        });
      }
    });
  }
});

/**
 * Enough of the GitHub Actions expression language to evaluate routes and
 * concurrency keys: property paths, string literals, null, `==`, `!=`, `&&`, `||` and
 * parentheses, negation and cancelled(). String comparison is case-insensitive, as it is in Actions.
 * Anything else throws, so a route the evaluator cannot read fails the test.
 */
function evaluate(expression: string, context: Obj): Json {
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

describe("CI concurrency configuration (scheduler behavior is verified in Depot)", () => {
  const ciPairs = pairs.filter(pair => pair.spec.source.endsWith("/ci.yml"));
  const push = (sha: string): Obj => ({ event_name: "push", ref: "refs/heads/main", sha });
  const pr = (number: number, sha: string): Obj => ({
    event_name: "pull_request", ref: `refs/pull/${number}/merge`, sha,
  });
  const key = (workflow: Workflow, event: Obj): string => {
    const context = { github: { ...event, workflow: workflow.name } };
    return String((workflow.concurrency as Obj).group).replace(
      /\$\{\{\s*([^}]*?)\s*\}\}/g,
      (_, expression: string) => String(evaluate(expression, context)),
    );
  };

  test("the evaluator preserves selected string values", () => {
    expect(ciPairs).toHaveLength(1);
    expect(evaluate("github.event_name == 'pull_request' && github.ref || github.sha", { github: push("a".repeat(40)) }))
      .toBe("a".repeat(40));
    expect(evaluate("github.event_name == 'pull_request' && github.ref || github.sha", { github: pr(7, "b".repeat(40)) }))
      .toBe("refs/pull/7/merge");
  });

  for (const { spec, source, adapter } of ciPairs) {
    for (const [label, workflow] of [[spec.source, source], [spec.target, adapter]] as const) {
      test(`${label}: main commits cannot replace one another's pending group`, () => {
        expect(key(workflow, push("a".repeat(40)))).not.toBe(key(workflow, push("b".repeat(40))));
      });
      test(`${label}: superseded heads of one PR share a group, distinct PRs do not`, () => {
        const first = key(workflow, pr(7, "a".repeat(40)));
        expect(first).toBe(key(workflow, pr(7, "b".repeat(40))));
        expect(first).not.toBe(key(workflow, pr(8, "a".repeat(40))));
        expect(first).not.toBe(key(workflow, push("a".repeat(40))));
      });
      test(`${label}: only superseded PR executions cancel running work`, () => {
        const expression = String((workflow.concurrency as Obj)["cancel-in-progress"])
          .replace(/^\$\{\{\s*|\s*\}\}$/g, "");
        expect(evaluate(expression, { github: push("a".repeat(40)) })).toBe(false);
        expect(evaluate(expression, { github: pr(7, "a".repeat(40)) })).toBe(true);
      });
    }
  }
});

const REPO = "schlessera/brain-kit";
const pullRequest = (headRepo: string | null, extra: Obj = {}): Obj => ({
  event_name: "pull_request",
  repository: REPO,
  event: {
    pull_request: {
      number: 7,
      title: "fix(core): steer between Scylla and Charybdis",
      labels: [],
      head: { sha: "1".repeat(40), repo: headRepo === null ? null : { full_name: headRepo } },
      ...extra,
    },
  },
});

const EVENTS: Record<string, { context: Obj; provider: "depot" | "github" }> = {
  "fork pull request": { context: pullRequest("odysseus/brain-kit"), provider: "github" },
  "fork pull request whose fork was deleted": { context: pullRequest(null), provider: "github" },
  "same-repository pull request": { context: pullRequest(REPO), provider: "depot" },
  "same-repository pull request, differently cased": {
    context: pullRequest("Schlessera/Brain-Kit"),
    provider: "depot",
  },
  "push to main": { context: { event_name: "push", repository: REPO, event: { before: "0".repeat(40) } }, provider: "depot" },
  "local Depot api run": { context: { event_name: "api", repository: REPO, event: {} }, provider: "depot" },
};

/**
 * Whether a provider would run the job for this event: its workflow must be
 * triggered by the event, then the job's route must hold. Depot is modelled
 * as receiving fork pull requests too, as it will once it supports them, so
 * the routes must already keep it off them. A local `depot ci run` arrives as
 * the `api` event, which GitHub Actions never receives.
 */
function runs(provider: "depot" | "github", workflow: Workflow, job: Job, context: Obj): boolean {
  const event = String(context.event_name);
  const triggered = event in workflow.on || (provider === "depot" && event === "api");
  return triggered && evaluate(job.if!, { github: context,
    needs: { changeset: { result: "success", outputs: { verify: "true", pack: "true" } }, pack: { result: "success" } } }) === true;
}

describe("longer packaging completes before short verification (live scheduler proof remains required)", () => {
  const ci = pairs.find(pair => pair.spec.source.endsWith("/ci.yml"))!;
  for (const [label, workflow, repo] of [[ci.spec.source, ci.source, REPO],
    [ci.spec.target, ci.adapter, "odysseus/brain-kit"]] as const) {
    const selected = (pack: string, result: string, cancelled = false, verify = "true", changeset = "success") => ({
      github: pullRequest(repo), cancelled,
      needs: { changeset: { result: changeset, outputs: { verify, pack } }, pack: { result } },
    });
    test(`${label}: the dependency prevents verification starting beside packaging`, () => {
      expect(workflow.jobs.pack!.needs).toBe("changeset");
      expect(workflow.jobs.verify!.needs).toEqual(["changeset", "pack"]);
      for (const state of ["", "queued", "in_progress"]) {
        expect(evaluate(workflow.jobs.verify!.if!, selected("true", state))).toBe(false);
      }
      expect(evaluate(workflow.jobs.verify!.if!, selected("true", "success"))).toBe(true);
    });
    test(`${label}: an intentional pack skip still permits selected verification`, () => {
      // GitHub implicitly adds success() unless a status function is present;
      // without this override, a skipped pack would hide all tests-only checks.
      expect(workflow.jobs.verify!.if).toContain("!cancelled()");
      expect(evaluate(workflow.jobs.verify!.if!, selected("false", "skipped"))).toBe(true);
      expect(evaluate(workflow.jobs.verify!.if!, selected("true", "skipped"))).toBe(false);
    });
    test(`${label}: failure, cancellation and unselected checks never trigger downstream work`, () => {
      for (const state of ["failure", "cancelled"]) {
        expect(evaluate(workflow.jobs.verify!.if!, selected("true", state))).toBe(false);
      }
      expect(evaluate(workflow.jobs.verify!.if!, selected("true", "success", true))).toBe(false);
      expect(evaluate(workflow.jobs.verify!.if!, selected("false", "skipped", true))).toBe(false);
      expect(evaluate(workflow.jobs.verify!.if!, selected("false", "skipped", false, "false"))).toBe(false);
      for (const state of ["failure", "cancelled", "skipped"]) {
        expect(evaluate(workflow.jobs.verify!.if!, selected("false", "skipped", false, "true", state))).toBe(false);
      }
    });
  }
});

describe("exactly one provider runs each job for each kind of contribution", () => {
  test("unaffected or draft selections skip dependent jobs on both providers", () => {
    const ci = pairs.find(pair => pair.spec.source.endsWith("/ci.yml"))!;
    for (const [workflow, route] of [[ci.source, REPO], [ci.adapter, "odysseus/brain-kit"]] as const) {
      const context = { github: pullRequest(route), needs: {
        changeset: { result: "success", outputs: { verify: "false", pack: "false" } }, pack: { result: "skipped" },
      } };
      expect(evaluate(workflow.jobs.changeset!.if!, context)).toBe(true);
      expect(evaluate(workflow.jobs.verify!.if!, context)).toBe(false);
      expect(evaluate(workflow.jobs.pack!.if!, context)).toBe(false);
    }
  });
  test("the evaluator reads the routes rather than defaulting", () => {
    expect(() => evaluate("github.x ~ 'y'", {})).toThrow();
    expect(evaluate(DEPOT_ROUTE, { github: pullRequest(REPO) })).toBe(true);
    expect(evaluate(DEPOT_ROUTE, { github: pullRequest("odysseus/brain-kit") })).toBe(false);
  });

  for (const { spec, source, adapter } of pairs) {
    for (const [label, { context, provider }] of Object.entries(EVENTS)) {
      test(`${spec.source}: ${label} runs on ${provider}`, () => {
        const event = String(context.event_name);
        // contract.yml has no push trigger: a push runs it nowhere.
        const expected = event in source.on || event === "api" ? provider : "nowhere";
        const ids = Object.keys(source.jobs);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
          const depot = runs("depot", source, source.jobs[id]!, context);
          const github = runs("github", adapter, adapter.jobs[id]!, context);
          expect({ id, depot, github }).toEqual({ id, depot: expected === "depot", github: expected === "github" });
        }
      });
    }
  }
});

describe("the adapters keep fork execution unprivileged", () => {
  // The only expressions a run script may interpolate. Everything a fork
  // controls (title, body, branch name, labels) reaches a script through env.
  const RUN_EXPRESSIONS = new Set(["matrix.shard", "github.event_name", "github.base_ref", "github.event.before"]);

  for (const { spec, adapter } of pairs) {
    test(`${spec.target}: no secret, write permission or privileged trigger`, () => {
      const text = read(spec.target);
      expect(text).not.toMatch(/\bsecrets\.|pull_request_target|workflow_run|id-token|: write\b/);
      expect(adapter.permissions).toEqual({ contents: "read" });
    });

    test(`${spec.target}: run scripts interpolate no fork-controlled value`, () => {
      const used: string[] = [];
      for (const job of Object.values(adapter.jobs)) {
        for (const step of job.steps) {
          for (const match of (step.run ?? "").matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) used.push(match[1]!);
        }
      }
      for (const expression of used) expect([expression, RUN_EXPRESSIONS.has(expression)]).toEqual([expression, true]);
    });
  }

  test("a fork's hostile title stays inert in the emitted contract step", () => {
    const adapter = pairs.find((p) => p.spec.source.endsWith("contract.yml"))!.adapter;
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

describe("the generator refuses what it has no rule for", () => {
  const spec = { source: "synthetic.yml", target: "synthetic-fork.yml" };
  const workflow = (job: string, on = "on:\n  pull_request:\n") =>
    `name: CI\n\n${on}\npermissions:\n  contents: read\n\njobs:\n${job}`;
  const job = (runner = "depot-ubuntu-24.04", route = `    if: ${DEPOT_ROUTE}\n`) =>
    `  build:\n${route}    runs-on: ${runner}\n    steps:\n      - uses: actions/checkout@v7\n      - run: bun run build\n`;

  test("a well-formed source generates", () => {
    expect(generateAdapter(workflow(job()), spec)).toContain("    runs-on: ubuntu-24.04\n");
  });
  test("an unmapped runner", () => {
    expect(() => generateAdapter(workflow(job("depot-ubuntu-24.04-arm")), spec)).toThrow(/no GitHub-hosted mapping/);
  });
  test("a job without the Depot route", () => {
    expect(() => generateAdapter(workflow(job(undefined, "")), spec)).toThrow(/exactly one `if:/);
    expect(() => generateAdapter(workflow(job(undefined, "    if: always()\n")), spec)).toThrow(/must be routed/);
  });
  test("a trigger without an adaptation rule", () => {
    expect(() => generateAdapter(workflow(job(), "on:\n  pull_request:\n  workflow_dispatch:\n"), spec)).toThrow(
      /workflow_dispatch/
    );
  });
  test("a secret or a privileged trigger", () => {
    expect(() => generateAdapter(workflow(job()).replace("bun run build", "echo ${{ secrets.NPM_TOKEN }}"), spec)).toThrow(
      /secrets/
    );
    expect(() => generateAdapter(workflow(job(), "on:\n  pull_request_target:\n"), spec)).toThrow(/pull_request_target/);
  });
});
