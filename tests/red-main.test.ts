import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planChecks, workspaces } from "../scripts/ci-plan";
import { GitReservationStore } from "../scripts/integration-reservation";
import { addSuspect, classifyFailure, clearRed, declareFix, emptyRedMain, FLAKE_WINDOW_MS, gateDecision, includeRedSet, junitFailures,
  openRed, parseRedMain, type RedFailure, type RedMainRecord } from "../scripts/red-main";
import { coordinate, includedRedSet, incidentMarker, type CoordinatorIO, type Job, type Snapshot, type WorkflowRun } from "../scripts/red-main-coordinator";

const ROOT = resolve(import.meta.dir, "..");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const NOW = Date.parse("2026-07-12T00:00:00Z");
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const failure = (test: string | null, category: RedFailure["category"] = "unit"): RedFailure =>
  ({ test, category, verdict: "real", reasons: ["in-affected-closure"], run: 11, sha: B });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-red-main-")); scratch.push(dir);
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env,
      GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid", GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(p.exitCode, new TextDecoder().decode(p.stderr)).toBe(0);
    return new TextDecoder().decode(p.stdout).trim();
  };
  return { dir, git };
}

describe("flake estimator", () => {
  test("an out-of-closure timeout is a suspected flake, an in-closure assertion is real, and a second suspicion is real", () => {
    const record = emptyRedMain();
    expect(classifyFailure({ test: "tests/raft.test.ts", category: "unit", signature: "timeout", inClosure: false }, record, NOW).verdict, "OUTSIDE_CLOSURE_TIMEOUT_SUSPECTED").toBe("suspected-flake");
    expect(classifyFailure({ test: "tests/raft.test.ts", category: "unit", signature: "assertion", inClosure: true }, record, NOW).verdict, "IN_CLOSURE_ASSERTION_REAL").toBe("real");
    const suspected = addSuspect(record, { test: "tests/raft.test.ts", category: "unit", run: 9, sha: A, at: NOW - 1000 }, NOW - 1000);
    const second = classifyFailure({ test: "tests/raft.test.ts", category: "unit", signature: "timeout", inClosure: false }, suspected, NOW);
    expect(second.verdict, "SECOND_SUSPECTED_FLAKE_ESCALATES").toBe("real");
    expect(second.reasons).toContain("repeated-suspected-flake");
    // Outside the configured window the earlier suspicion no longer escalates.
    expect(classifyFailure({ test: "tests/raft.test.ts", category: "unit", signature: "timeout", inClosure: false }, suspected, NOW + FLAKE_WINDOW_MS).verdict).toBe("suspected-flake");
    // An unknown closure fails closed to real, never to a flake.
    expect(classifyFailure({ test: "tests/raft.test.ts", category: "unit", signature: "timeout", inClosure: null }, record, NOW).verdict).toBe("real");
  });

  test("JUnit failures name each failing file with its signature", () => {
    const xml = `<testsuites tests="3" failures="2"><testsuite name="tests/a.test.ts" file="tests/a.test.ts" failures="1"><testcase name="x"><failure message="Timed out after 5000ms"/></testcase></testsuite>
      <testsuite name="tests/b.test.ts" file="tests/b.test.ts" failures="1"><testcase name="y"><failure type="AssertionError">expect(received).toBe(expected)</failure></testcase></testsuite>
      <testsuite name="tests/c.test.ts" file="tests/c.test.ts" failures="0"><testcase name="z"/></testsuite></testsuites>`;
    expect(junitFailures(xml)).toEqual([{ test: "tests/a.test.ts", signature: "timeout" }, { test: "tests/b.test.ts", signature: "assertion" }]);
  });
});

describe("red-main record", () => {
  test("records validate, merge new failures, clear only from a green run that included the set", () => {
    let record = openRed(emptyRedMain(), { firstBad: B, run: 11, failures: [failure("tests/raft.test.ts")] }, NOW);
    record = openRed(record, { firstBad: C, run: 12, failures: [failure("tests/raft.test.ts"), failure(null, "browser")] }, NOW + 1);
    expect(record.open?.firstBad).toBe(B); expect(record.open?.failures).toHaveLength(2);
    expect(parseRedMain(JSON.stringify(record))).toEqual(record);
    expect(() => parseRedMain(JSON.stringify({ ...record, open: { ...record.open, firstBad: "nope" } }))).toThrow("Invalid red-main incident");
    expect(() => clearRed(record, { id: 13, conclusion: "success", included: { run: 11, firstBad: B, failures: [failure("tests/raft.test.ts")] } }, NOW + 2)).toThrow("included the open red set");
    expect(() => clearRed(record, { id: 13, conclusion: "failure", included: { run: 11, firstBad: B, failures: record.open!.failures } }, NOW + 2)).toThrow();
    expect(clearRed(record, { id: 13, conclusion: "success", included: { run: 11, firstBad: B, failures: record.open!.failures } }, NOW + 2).open).toBeNull();
  });

  test("two concurrent coordinators cannot both write the record through the remote compare-and-swap", async () => {
    const { dir, git } = repo();
    const remote = join(dir, "remote.git"); git(dir, "init", "--bare", remote);
    for (const name of ["one", "two"]) { mkdirSync(join(dir, name)); git(join(dir, name), "init"); git(join(dir, name), "remote", "add", "origin", remote); }
    const script = join(dir, "contender.ts");
    writeFileSync(script, `import { existsSync, writeFileSync } from "node:fs";
      import { GitReservationStore } from ${JSON.stringify(join(ROOT, "scripts/integration-reservation.ts"))};
      import { openRed, emptyRedMain } from ${JSON.stringify(join(ROOT, "scripts/red-main.ts"))};
      const [root, number, barrier] = process.argv.slice(2), store = new GitReservationStore(root), snapshot = store.read();
      writeFileSync(barrier + number, "ready"); while (!existsSync(barrier + "1") || !existsSync(barrier + "2")) await Bun.sleep(5);
      if (number === "2") while (!existsSync(barrier + "published")) await Bun.sleep(5);
      const record = openRed(emptyRedMain(), { firstBad: "${B}", run: Number(number), failures: [{ test: "tests/raft.test.ts", category: "unit", verdict: "real", reasons: ["in-affected-closure"], run: Number(number), sha: "${B}" }] }, ${NOW});
      const published = store.publishRedMain(snapshot, record); if (number === "1") writeFileSync(barrier + "published", "done");
      console.log(JSON.stringify({ published }));`);
    const children = ["1", "2"].map((id, index) => Bun.spawn([process.execPath, script, join(dir, index ? "two" : "one"), id, join(dir, "barrier-")], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async child => {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, err).toBe(0); return JSON.parse(out).published as boolean;
    }));
    expect(results, "ONLY_ONE_RED_MAIN_WRITER_SUCCEEDS").toEqual([true, false]);
    const store = new GitReservationStore(join(dir, "two")), snapshot = store.read();
    expect(snapshot.redMain.open?.run).toBe(1);
    // The reservation file is preserved beside the record, and clearing writes through the same ref.
    expect(snapshot.state.active).toBeNull();
    const cleared = clearRed(snapshot.redMain, { id: 3, conclusion: "success", included: { run: 1, firstBad: B, failures: snapshot.redMain.open!.failures } }, NOW + 1);
    expect(store.publishRedMain(snapshot, cleared)).toBe(true);
    expect(store.read().redMain.open).toBeNull();
    expect(store.read().redMain.last?.action).toBe("clear");
  });
});

describe("main selection includes the open red set", () => {
  test("a later main run that does not touch the red test's closure still runs it", () => {
    const packages = workspaces(ROOT), replan = (changed: string[]) => planChecks(changed, packages, ROOT, false);
    const plan = replan(["docs/README.md"]);
    expect(plan.local.fullTests).toBe(false); expect(plan.local.browser).toBe(false);
    const record = openRed(emptyRedMain(), { firstBad: B, run: 11, failures: [failure("packages/core/tests/frontmatter.test.ts"), failure(null, "browser")] }, NOW);
    const widened = includeRedSet(plan, record, replan);
    expect(widened.local.fullTests, "RED_UNIT_TEST_SELECTED_WITHOUT_CLOSURE_CHANGE").toBe(true);
    expect(widened.local.browser, "RED_CATEGORY_SELECTED").toBe(true);
    expect(widened.changed).toEqual(["docs/README.md"]);
    expect(widened.redMain).toEqual({ run: 11, firstBad: B, failures: record.open!.failures });
    expect(includeRedSet(plan, emptyRedMain(), replan)).toBe(plan);
  });

  test("the planner executable pins one coordination snapshot and prints the included set", () => {
    const { dir, git } = repo();
    git(dir, "init", "-q"); git(dir, "remote", "add", "origin", dir);
    for (const name of ["core", "ui-sdk"]) { mkdirSync(join(dir, "packages", name, "src"), { recursive: true });
      writeFileSync(join(dir, "packages", name, "package.json"), JSON.stringify({ name: `@fixture/${name}`, files: ["src"] })); writeFileSync(join(dir, "packages", name, "src/index.ts"), "export {};\n"); }
    mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "scripts/ci-plan.ts"), readFileSync(join(ROOT, "scripts/ci-plan.ts"), "utf8").replace('"typescript"', JSON.stringify(import.meta.resolve("typescript"))));
    for (const name of ["browser-input-closure", "unit-test-consumers", "integration-reservation", "red-main"]) writeFileSync(join(dir, `scripts/${name}.ts`), `export * from ${JSON.stringify(join(ROOT, `scripts/${name}.ts`))};\n`);
    writeFileSync(join(dir, "docs/notes.md"), "Ithaca.\n"); git(dir, "add", "."); git(dir, "commit", "-qm", "base");
    const before = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "docs/notes.md"), "Ithaca, again.\n"); git(dir, "commit", "-qam", "docs only");
    const store = new GitReservationStore(dir);
    expect(store.publishRedMain(store.read(), openRed(emptyRedMain(), { firstBad: before, run: 11, failures: [failure("packages/core/src/index.test.ts")] }, NOW))).toBe(true);
    const oid = git(dir, "rev-parse", "refs/heads/brain-integration-reservation");
    const plan = (requested?: string) => {
      const output = join(dir, `out-${requested ?? "resolve"}`), event = join(dir, "event.json");
      writeFileSync(event, JSON.stringify({ before }));
      const p = Bun.spawnSync([process.execPath, join(dir, "scripts/ci-plan.ts")], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env,
        GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, BEFORE_SHA: before, HEAD_SHA: "HEAD", GITHUB_OUTPUT: output, CI_PLAN_PATH: join(dir, "plan.json"),
        ...(requested ? { RED_MAIN_OID: requested } : {}) } });
      expect(p.exitCode, new TextDecoder().decode(p.stderr)).toBe(0);
      return { outputs: readFileSync(output, "utf8"), stdout: new TextDecoder().decode(p.stdout) };
    };
    const resolved = plan();
    expect(resolved.outputs).toContain(`red_main_oid=${oid}\n`);
    expect(resolved.outputs, "PUSH_RUNS_RED_UNIT_TEST").toContain("unit=true\n");
    expect(includedRedSet(resolved.stdout)?.run).toBe(11);
    // A later job receives the same snapshot even after the record changes.
    expect(store.publishRedMain(store.read(), clearRed(store.read().redMain, { id: 12, conclusion: "success", included: { run: 11, firstBad: before, failures: store.read().redMain.open!.failures } }, NOW + 1))).toBe(true);
    expect(plan(oid).outputs, "PINNED_SNAPSHOT").toContain("unit=true\n");
    expect(plan("none").outputs).toContain("unit=false\n");
  });
});

describe("hosted gate", () => {
  test("refuses a non-fix PR whose merge ref contains the bad SHA and admits a declared fix", () => {
    const { dir, git } = repo();
    git(dir, "init", "-q"); git(dir, "remote", "add", "origin", dir);
    writeFileSync(join(dir, "raft.md"), "1\n"); git(dir, "add", "."); git(dir, "commit", "-qm", "good");
    const good = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "raft.md"), "2\n"); git(dir, "commit", "-qam", "bad");
    const bad = git(dir, "rev-parse", "HEAD");
    const store = new GitReservationStore(dir);
    expect(store.publishRedMain(store.read(), declareFix(openRed(emptyRedMain(), { firstBad: bad, run: 11, failures: [failure("tests/raft.test.ts")] }, NOW), 8, NOW + 1))).toBe(true);
    const gate = (pr: number) => {
      const p = Bun.spawnSync([process.execPath, join(ROOT, "scripts/red-main-cli.ts"), "gate"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PR_NUMBER: String(pr) } });
      return { code: p.exitCode, text: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
    };
    const refused = gate(7);
    expect(refused.code, "NON_FIX_CONTAINING_BAD_SHA_REFUSED").toBe(1);
    expect(refused.text).toContain(`main red at ${bad}, incident pending`);
    expect(gate(8).code, "DECLARED_FIX_ADMITTED").toBe(0);
    git(dir, "checkout", "-q", good);
    expect(gate(7).code, "MERGE_REF_WITHOUT_BAD_SHA_ADMITTED").toBe(0);
    expect(gateDecision({ record: emptyRedMain(), pr: 7, contains: () => true }).refuse).toBe(false);
  });
});

/** In-memory GitHub plus a real-shape record store for the coordinator. */
function fakeGitHub(options: { jobs: Job[]; junit?: string; closure?: boolean | null; pulls?: Record<string, number>; prRuns?: WorkflowRun[]; history?: WorkflowRun[]; historyJobs?: Record<number, Job[]> }) {
  let snapshot: Snapshot = { oid: null, redMain: emptyRedMain() }, version = 0, clock = NOW;
  const issues: { number: number; title: string; body: string; labels: string[] }[] = [];
  const comments: { issue: number; body: string }[] = [], cancelled: number[] = [], dispatched: unknown[] = [], events: unknown[] = [];
  const io: CoordinatorIO = {
    repository: "odysseus/brain-kit",
    async json(path) {
      if (path.startsWith("search/issues")) {
        const query = decodeURIComponent(path.split("q=")[1]!.split("&")[0]!);
        const phrase = /"([^"]+)"/.exec(query)?.[1] ?? "";
        return { items: issues.filter(issue => issue.body.includes(phrase) || issue.title.includes(phrase)) };
      }
      const jobsMatch = /actions\/runs\/(\d+)\/attempts\/\d+\/jobs/.exec(path);
      if (jobsMatch) return { jobs: Number(jobsMatch[1]) >= 100 ? options.jobs : options.historyJobs?.[Number(jobsMatch[1])] ?? [] };
      if (path.includes("ci.yml/runs?event=pull_request")) return { workflow_runs: path.includes("in_progress") ? options.prRuns ?? [] : [] };
      if (path.includes("ci.yml/runs?event=push")) return { workflow_runs: options.history ?? [] };
      const pulls = /commits\/([a-f0-9]{40})\/pulls/.exec(path);
      if (pulls) return options.pulls?.[pulls[1]!] ? [{ number: options.pulls[pulls[1]!], merged_at: "2026-07-12T00:00:00Z" }] : [];
      throw new Error(`Unexpected offline API ${path}`);
    },
    async write(method, path, body: any) {
      if (path.endsWith("/issues")) { const issue = { number: 500 + issues.length, ...body }; issues.push(issue); return issue; }
      const comment = /issues\/(\d+)\/comments$/.exec(path);
      if (comment) { comments.push({ issue: Number(comment[1]), body: body.body }); return {}; }
      const cancel = /actions\/runs\/(\d+)\/cancel$/.exec(path);
      if (cancel) { cancelled.push(Number(cancel[1])); return {}; }
      if (path.endsWith("/dispatches")) { dispatched.push(body); return {}; }
      throw new Error(`Unexpected offline write ${method} ${path}`);
    },
    async now() { return clock += 1000; },
    read() { return { oid: String(version), redMain: snapshot.redMain }; },
    publish(seen, record) { if (seen.oid !== String(version)) return false; version++; snapshot = { oid: String(version), redMain: parseRedMain(JSON.stringify(record)) }; return true; },
    async artifactFiles(_run, name) { return name === "unit-proof-2" && options.junit ? [options.junit] : []; },
    async log() { return ""; },
    inClosure: () => options.closure ?? true,
    range: (since, until) => since === A && until === C ? [B, C] : [],
    isAncestor: (a, b) => a === b || (a === A && b !== A) || (a === B && b === C),
    commitTime: () => NOW,
    async recordEvent(event) { events.push(event); },
    print() {},
  };
  return { io, issues, comments, cancelled, dispatched, events, record: () => snapshot.redMain, set: (record: RedMainRecord) => { snapshot = { oid: String(++version), redMain: record }; } };
}
const mainRun = (sha: string, conclusion: string, id = 100): WorkflowRun => ({ id, name: "CI", event: "push", head_branch: "main", head_sha: sha, status: "completed", conclusion,
  run_attempt: 1, display_title: "squash", created_at: "2026-07-12T00:00:00Z" });
const junit = `<testsuites><testsuite name="packages/core/tests/raft.test.ts" file="packages/core/tests/raft.test.ts" failures="1"><testcase name="t"><failure>expect(received).toBe(expected)</failure></testcase></testsuite></testsuites>`;

describe("coordinator", () => {
  test("two coordinator runs for the same bad SHA and test leave exactly one incident issue and cancel doomed PR proof", async () => {
    const gh = fakeGitHub({ jobs: [{ id: 1, name: "changeset", conclusion: "success" }, { id: 2, name: "unit (2)", conclusion: "failure", steps: [] }], junit,
      prRuns: [{ ...mainRun(A, "", 300), event: "pull_request", head_branch: "feat", status: "in_progress", pull_requests: [{ number: 7 }], created_at: "2026-07-12T00:00:01Z" },
        { ...mainRun(A, "", 301), event: "pull_request", head_branch: "fix", status: "in_progress", pull_requests: [{ number: 8 }], created_at: "2026-07-12T00:00:01Z" }] });
    await coordinate(gh.io, mainRun(B, "failure"));
    gh.set(declareFix(gh.record(), 8, NOW + 100_000));
    await coordinate(gh.io, mainRun(B, "failure"));
    expect(gh.issues, "EXACTLY_ONE_INCIDENT_ISSUE").toHaveLength(1);
    expect(gh.issues[0]!.body).toContain(incidentMarker(100));
    expect(gh.issues[0]!.title).toContain("packages/core/tests/raft.test.ts");
    expect(gh.record().open).toMatchObject({ firstBad: B, incident: 500, failures: [{ test: "packages/core/tests/raft.test.ts", reasons: ["in-affected-closure", "assertion-signature"] }] });
    // Before PR #8 is declared a fix both runs are doomed; afterwards only the non-fix run is cancelled.
    expect(gh.cancelled, "DOOMED_NON_FIX_RUN_CANCELLED_FIX_KEPT").toEqual([300, 301, 300]);
  });

  test("a suspected flake files its test issue and dispatches a probe without declaring main red", async () => {
    const gh = fakeGitHub({ jobs: [{ id: 2, name: "unit (2)", conclusion: "failure", steps: [] }], closure: false,
      junit: junit.replace("<failure>expect(received).toBe(expected)</failure>", "<failure message=\"Timed out after 5000ms\"/>") });
    await coordinate(gh.io, mainRun(B, "failure"));
    expect(gh.record().open).toBeNull();
    expect(gh.record().suspects).toMatchObject([{ test: "packages/core/tests/raft.test.ts", probe: "pending", issue: 500 }]);
    expect(gh.issues[0]!.title).toBe("test: suspected flake in packages/core/tests/raft.test.ts");
    expect(gh.dispatched).toEqual([{ ref: "main", inputs: { purpose: "flake", source_run: "100", sha: B, tests: JSON.stringify(["packages/core/tests/raft.test.ts"]) } }]);
    // The failed probe reproduces it: main is declared red and the flake issue is updated.
    await coordinate(gh.io, { ...mainRun(B, "failure", 200), name: "red-main-probe", event: "workflow_dispatch", display_title: `red-main probe flake 100 ${B}` });
    expect(gh.record().open?.failures[0]?.reasons).toEqual(["probe-reproduced"]);
    expect(gh.comments.some(comment => comment.issue === 500 && comment.body.includes("**failed**"))).toBe(true);
  });

  test("first bad is the first commit after the last green run, and a squash landed while red is reported", async () => {
    const history = [mainRun(A, "success", 90)];
    const gh = fakeGitHub({ jobs: [{ id: 2, name: "unit (2)", conclusion: "failure", steps: [] }], junit, history,
      historyJobs: { 90: [{ id: 9, name: "unit (1)", conclusion: "success" }] }, pulls: { [C]: 7 } });
    await coordinate(gh.io, mainRun(C, "failure"));
    expect(gh.record().open?.firstBad, "FIRST_RED_AFTER_LAST_GREEN").toBe(B);
    expect(gh.dispatched.filter((d: any) => d.inputs.purpose === "bisect")).toHaveLength(2);
    // The next main run's squash C lands while red without being a declared fix.
    await coordinate(gh.io, mainRun(C, "failure", 101));
    expect(gh.comments.filter(comment => comment.issue === 7), "LANDED_WHILE_RED_REPORTED_ON_PR").toHaveLength(1);
    expect(gh.comments.some(comment => comment.issue === 500 && comment.body.includes("landed while red"))).toBe(true);
    expect(gh.events).toEqual([{ kind: "incident", pr: 7, run: 101, evidence: "https://github.com/odysseus/brain-kit/issues/500" }]);
    expect(gh.record().open?.reported).toEqual([C]);
    await coordinate(gh.io, mainRun(C, "failure", 102));
    expect(gh.comments.filter(comment => comment.issue === 7), "REPORTED_ONCE").toHaveLength(1);
  });

  test("a green main run clears the record only when it included the open set", async () => {
    const gh = fakeGitHub({ jobs: [{ id: 1, name: "changeset", conclusion: "success" }] });
    const record = openRed(emptyRedMain(), { firstBad: B, run: 11, failures: [failure("tests/raft.test.ts")] }, NOW);
    gh.set(record);
    gh.io.log = async () => "";
    await coordinate(gh.io, mainRun(C, "success"));
    expect(gh.record().open, "GREEN_WITHOUT_RED_SET_DOES_NOT_CLEAR").not.toBeNull();
    gh.io.log = async () => `2026-07-12T00:00:00Z BRAIN_RED_MAIN_INCLUDED ${JSON.stringify({ run: 11, firstBad: B, failures: record.open!.failures })}`;
    await coordinate(gh.io, mainRun(C, "success", 103));
    expect(gh.record().open).toBeNull();
    expect(existsSync(ROOT)).toBe(true);
  });
});
