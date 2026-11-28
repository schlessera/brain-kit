/**
 * In-process decisions of the integration command (#4848): a fake `IntegrateIO`
 * drives `runIntegrate` with an injected clock, timer, `gh` and reservation store.
 * No case spawns a process, creates a repository or reads `PATH`;
 * `tests/integration-command.test.ts` stays the subprocess proof of the real Git
 * compare-and-swap, argument parsing and process exit.
 */
import { expect, test } from "bun:test";
import { runIntegrate, type IntegrateIO } from "../scripts/integrate";
import { emptyReservation, parseReservation, RENEW_MS, type ReservationState } from "../scripts/integration-reservation";
import { declareFix, emptyRedMain, openRed, parseRedMain, type RedMainRecord } from "../scripts/red-main";
import { receiptBlock, type CheckReceipt } from "../scripts/check-receipt";
import { fixProbeTitle, PROBE_RECEIPT } from "../scripts/red-main-expedite";

const NOW = Date.parse("2026-07-12T00:00:00Z");
const REPO = "odysseus/brain-kit", PR = 7, ACTOR = 101;
const BASE = "b".repeat(40), HEAD = "a".repeat(40), SQUASH = "c".repeat(40), TREE = "d".repeat(40), MOVED = "e".repeat(40);
const ISSUES = ["--issues", `${REPO}#9`];

const receipt: CheckReceipt = { version: 1, kind: "brain-check-pr-receipt", head: HEAD, base: "origin/main", mode: "focused",
  startedAt: "2026-07-12T00:00:00.000Z", finishedAt: "2026-07-12T00:05:00.000Z",
  checks: [{ name: "all lint and leakage gates", categories: ["changeset"], outcome: "passed" }, { name: "affected fast invariants", categories: ["verify", "unit"], outcome: "passed" }] };

interface World {
  /** Monotonic milliseconds since NOW. */
  now: number;
  head: string;
  mainSha: string;
  draft: boolean;
  merged: boolean;
  requested: boolean;
  contract: "success" | "in_progress";
  /** Whether the candidate CI run requested by `gh pr ready` completes. */
  ciCompletes: boolean;
  /** The head the PR moves to once candidate CI is requested, if any. */
  headAfterRequest?: string;
  review: string | null;
  redMain: RedMainRecord;
  state: ReservationState;
  dispatched: string[];
  probeRun: number;
}

/** A fake world: every `gh` and store call is recorded; an unexpected one throws, which the command reports. */
function harness(setup: Partial<World> = {}) {
  const world: World = { now: 0, head: HEAD, mainSha: BASE, draft: true, merged: false, requested: false, contract: "success", ciCompletes: false,
    review: null, redMain: emptyRedMain(), state: emptyReservation(), dispatched: [], probeRun: 300, ...setup };
  let oid = 1;
  const calls = { gh: [] as string[][], publish: [] as string[], publishRedMain: [] as string[], reviews: 0, git: [] as string[][], writes: [] as string[], runs: [] as string[][] };
  const out: string[] = [], err: string[] = [];
  const timers = new Map<number, { tick: () => unknown; every: number; next: number }>();
  let timerId = 0;
  const run = (id: number, workflow: string, status = "completed", conclusion: string | null = "success") => ({ id, run_attempt: 1, event: "pull_request", head_sha: world.head,
    status, conclusion, repository: { html_url: `https://github.com/${REPO}` }, head_repository: { html_url: `https://github.com/${REPO}` }, pull_requests: [{ number: PR }], workflow });
  const probes = () => world.dispatched.map((sha, index) => ({ id: world.probeRun + 1 + index, run_attempt: 1, status: "completed",
    conclusion: sha === BASE ? "failure" : "success", display_title: fixProbeTitle(11, sha) }));
  const json = (path: string): unknown => {
    if (path === "user") return { id: ACTOR, login: "odysseus" };
    if (path === `pulls/${PR}`) return { number: PR, state: world.merged ? "closed" : "open", draft: world.draft, merged: world.merged, merge_commit_sha: SQUASH,
      head: { sha: world.head, repo: { full_name: REPO } }, base: { ref: "main", sha: BASE, repo: { full_name: REPO } }, milestone: { title: "0.46.0" },
      body: `Odysseus builds a raft.\n\n${receiptBlock(receipt)}\n` };
    if (path.endsWith("git/ref/heads/main")) return { object: { sha: world.mainSha } };
    if (path.endsWith("issues/9")) return { milestone: { title: "0.46.0" } };
    if (path.includes("actions/workflows/contract.yml/runs")) return { workflow_runs: [world.contract === "success" ? run(92, "contract") : run(92, "contract", "in_progress", null)] };
    if (path.includes("actions/workflows/ci.yml/runs?event=push")) return { workflow_runs: [] };
    if (path.includes("actions/workflows/ci.yml/runs")) return { workflow_runs: [world.requested && world.ciCompletes ? run(91, "ci") : run(90, "ci")] };
    if (path.includes("actions/workflows/red-main-probe.yml/runs")) return { workflow_runs: probes() };
    const probeJobs = /actions\/runs\/(\d+)\/attempts\/1\/jobs/.exec(path);
    if (probeJobs && Number(probeJobs[1]) > world.probeRun) return { jobs: [{ id: Number(probeJobs[1]) + 100, name: "probe", status: "completed" }] };
    if (probeJobs) return { jobs: [{ id: 1, name: "changeset", status: "completed", conclusion: "success" }, { id: 2, name: "verify", status: "completed", conclusion: "success" }] };
    if (path.endsWith(`git/commits/${SQUASH}`)) return { sha: SQUASH, tree: { sha: TREE }, parents: [{ sha: BASE }] };
    throw new Error(`Unexpected offline API ${path}`);
  };
  const log = (path: string): string => {
    if (path.endsWith("actions/jobs/1/logs")) return `"cadence": "confirmation"`;
    const probe = /actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (probe && Number(probe[1]) > world.probeRun + 100) {
      const sha = world.dispatched[Number(probe[1]) - world.probeRun - 101]!;
      return `2026-07-12T00:00:00Z ${PROBE_RECEIPT} ${JSON.stringify({ purpose: "fix", sha, tests: ["tests/raft.test.ts"], absent: [], exitCode: sha === BASE ? 1 : 0 })}`;
    }
    throw new Error(`Unexpected offline log ${path}`);
  };
  const io: IntegrateIO = {
    async gh(...args) {
      calls.gh.push(args);
      if (args[0] === "repo" && args[1] === "view") return REPO;
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ closingIssuesReferences: [{ url: `https://github.com/${REPO}/issues/9` }] });
      if (args[0] === "pr" && args[1] === "ready") { world.draft = args.includes("--undo"); if (!world.draft) { world.requested = true; world.head = world.headAfterRequest ?? world.head; } return "ready"; }
      if (args[0] === "pr" && args[1] === "merge") { world.merged = true; return "merged"; }
      if (args[0] !== "api") throw new Error(`Unexpected offline gh ${JSON.stringify(args)}`);
      if (args[1] === "--include") return `HTTP/2.0 200 OK\nDate: ${new Date(NOW + world.now).toUTCString()}\n\n{}`;
      if (args[1] === "--method") { world.dispatched.push(args.find(arg => arg.startsWith("inputs[sha]="))!.slice("inputs[sha]=".length)); return ""; }
      if (args[1] === "--allow-escape-sequences") return log(args[2]!);
      const path = args[1]!.replace(`repos/${REPO}/`, "");
      return JSON.stringify(json(path));
    },
    store: () => ({
      root: "/odysseus/checkout",
      git(args) {
        calls.git.push(args);
        if (args.join(" ") === "remote get-url origin") return `https://github.com/${REPO}.git`;
        if (args[0] === "merge-base" && args[1] !== "--is-ancestor") return BASE;
        if (args[0] === "diff" || args[0] === "fetch" || args[0] === "merge-base") return "";
        throw new Error(`Unexpected offline git ${JSON.stringify(args)}`);
      },
      read: () => ({ oid: String(oid), state: world.state, redMain: world.redMain }),
      publish(snapshot, state) {
        if (snapshot.oid !== String(oid)) return false;
        world.state = parseReservation(JSON.stringify(state)); oid++; calls.publish.push(state.last?.action ?? "state"); return true;
      },
      publishRedMain(snapshot, record) {
        if (snapshot.oid !== String(oid)) return false;
        world.redMain = parseRedMain(JSON.stringify(record)); oid++; calls.publishRedMain.push(record.last?.action ?? "state"); return true;
      },
    }),
    now: () => world.now,
    async sleep(ms) {
      // A bounded virtual hour: a decision that never settles fails here instead of spinning.
      if (world.now + ms > 60 * RENEW_MS) throw new Error("Virtual time budget exhausted");
      world.now += ms;
      for (const timer of timers.values()) while (timer.next <= world.now) { timer.next += timer.every; await timer.tick(); }
    },
    setInterval(tick, every) { timers.set(++timerId, { tick, every, next: world.now + every }); return timerId; },
    clearInterval(timer) { timers.delete(timer as number); },
    out: line => { out.push(line); },
    err: line => { err.push(line); },
    hasCommit: () => true,
    mergeTree: () => ({ exitCode: 0, stdout: `${TREE}\n` }),
    async write(path) { calls.writes.push(path); },
    run(command) { calls.runs.push(command); return { exitCode: 0, stderr: "" }; },
    isAncestor: sha => sha === BASE,
    async reviewGate() { calls.reviews++; return world.review; },
    classify: () => ({ proofSystem: false, reasons: [] }) as unknown as ReturnType<IntegrateIO["classify"]>,
    checkQualification: async () => { throw new Error("Unexpected qualification read"); },
    readLane: async () => { throw new Error("Unexpected lane read"); },
    verifyIntegrationProof: async () => { throw new Error("Unexpected integration proof read"); },
  };
  const commands = () => calls.gh.map(args => args[0] === "api" ? `api ${args.find(arg => arg.startsWith("repos/") || arg === "user") ?? args[1]}` : args.slice(0, 2).join(" "));
  return { world, calls, out, err, io, commands, timers };
}

function redRecord(declared = false) {
  const red = openRed(emptyRedMain(), { firstBad: BASE, run: 11, failures: [{ test: "tests/raft.test.ts", category: "unit", verdict: "real", reasons: ["in-affected-closure"], run: 11, sha: BASE }] }, NOW);
  return declared ? declareFix(red, PR, NOW) : red;
}

test("a stale candidate is refused before any reservation, review or CI request", async () => {
  const h = harness({ mainSha: MOVED });
  const code = await runIntegrate(["confirm", String(PR), ...ISSUES], h.io);
  expect(code, "STALE_EXIT").toBe(1);
  expect(h.err, "STALE_MESSAGE").toEqual(["An open ordinary exact-main candidate is required; refresh stale or unsupported native candidates"]);
  expect(h.commands(), "STALE_GH_CALLS").toEqual(["repo view", "api user", `api repos/${REPO}/pulls/${PR}`, `api repos/${REPO}/git/ref/heads/main`]);
  expect(h.calls.publish, "STALE_NO_RESERVATION").toEqual([]);
  expect(h.calls.reviews, "STALE_NO_REVIEW_READ").toBe(0);
  expect(h.out).toEqual([]);
});

test("a lost lease ends confirmation without a merge and releases the reservation", async () => {
  // The head moves once candidate CI is requested: the next renewal tick finds a different candidate.
  const h = harness({ headAfterRequest: MOVED });
  const code = await runIntegrate(["confirm", String(PR), ...ISSUES], h.io);
  expect(code, "LOST_EXIT").toBe(1);
  expect(h.err.at(-1), "LOST_MESSAGE").toBe("Candidate head/base changed; reacquisition and new confirmation required");
  expect(h.calls.publish, "LOST_ACQUIRE_THEN_RELEASE").toEqual(["acquire", "release"]);
  expect(h.commands(), "LOST_REQUESTED_CI").toContain("pr ready");
  expect(h.commands(), "LOST_NO_MERGE").not.toContain("pr merge");
  expect(h.out.map(line => Object.keys(JSON.parse(line))), "LOST_PRINTS_ONLY_THE_ACQUIRE").toEqual([["acquired"]]);
  expect(h.world.now, "LOST_ON_THE_FIRST_TICK").toBe(RENEW_MS);
  expect(h.timers.size, "LOST_STOPS_THE_HEARTBEAT").toBe(0);
});

test("a contract check still pending is waited for, then refused without a reservation or CI request", async () => {
  const h = harness({ contract: "in_progress" });
  const code = await runIntegrate(["confirm", String(PR), ...ISSUES], h.io);
  expect(code, "PENDING_EXIT").toBe(1);
  expect(h.err.at(-1), "PENDING_MESSAGE").toBe(`Newest contract run 92 for head ${HEAD} is in_progress after ${10 * RENEW_MS / 1000}s; confirm again once it completes. No reservation was taken and no candidate CI was requested.`);
  expect(h.err.filter(line => line.endsWith("waiting before taking the reservation")), "PENDING_WAITS_TEN_TIMES").toHaveLength(10);
  expect(h.world.now, "PENDING_WAITS_ON_THE_INJECTED_CLOCK").toBe(10 * RENEW_MS);
  expect(h.calls.publish, "PENDING_NO_RESERVATION").toEqual([]);
  expect(h.commands(), "PENDING_NO_CI_REQUEST").not.toContain("pr ready");
});

test("confirm refuses a missing review record before the lane, the contract, a reservation or CI", async () => {
  const refusal = "Core-package PR #7 has no recorded independent review for head " + HEAD;
  const h = harness({ review: refusal });
  const code = await runIntegrate(["confirm", String(PR), ...ISSUES], h.io);
  expect(code, "REVIEW_EXIT").toBe(1);
  expect(h.err, "REVIEW_MESSAGE").toEqual([refusal]);
  expect(h.calls.reviews, "REVIEW_READ_ONCE").toBe(1);
  expect(h.commands().filter(command => command.includes("contract.yml")), "REVIEW_NO_CONTRACT_READ").toEqual([]);
  expect(h.calls.git.filter(args => args[0] === "merge-base"), "REVIEW_NO_LANE_READ").toEqual([]);
  expect(h.calls.publish, "REVIEW_NO_RESERVATION").toEqual([]);
  expect(h.commands(), "REVIEW_NO_CI_REQUEST").not.toContain("pr ready");
});

test("red main refuses a candidate that contains the bad commit and is not a declared fix", async () => {
  const h = harness({ redMain: redRecord() });
  const code = await runIntegrate(["confirm", String(PR), ...ISSUES], h.io);
  expect(code, "RED_EXIT").toBe(1);
  expect(h.err, "RED_MESSAGE").toEqual([`main red at ${BASE}, incident pending; only a declared fix may confirm or merge (bun scripts/integrate.ts declare-fix <pr>)`]);
  expect(h.calls.publish, "RED_NO_RESERVATION").toEqual([]);
  expect(h.calls.publishRedMain, "RED_RECORD_UNCHANGED").toEqual([]);
  expect(h.commands(), "RED_NO_CI_REQUEST").not.toContain("pr ready");
});

test("red main with an expedited fix declares it, proves red on base and green on head, merges and records it", async () => {
  const h = harness({ redMain: redRecord(), ciCompletes: true });
  const code = await runIntegrate(["confirm", String(PR), ...ISSUES, "--fixes-main-run", "11"], h.io);
  expect(h.err, "EXPEDITE_NO_ERRORS").toEqual([]);
  expect(code, "EXPEDITE_EXIT").toBe(2);
  const [declared, acquired, merged] = h.out.map(line => JSON.parse(line));
  expect(declared, "EXPEDITE_DECLARED").toEqual({ declared: [PR] });
  expect(Object.keys(acquired), "EXPEDITE_ACQUIRED").toEqual(["acquired"]);
  expect(merged, "EXPEDITE_MERGED").toEqual({ merged: true, sha: SQUASH, candidateRun: 91, mainProof: "pending; inspect actual main jobs before claiming full completion",
    observedMainConclusion: null, expedited: { fixesMainRun: 11, baseProbe: 301, headProbe: 302,
      backstop: "the next main run includes the open red set; only its green result clears the record" } });
  expect(h.world.dispatched, "EXPEDITE_PROBES_BOTH_SIDES").toEqual([BASE, HEAD]);
  expect(h.commands().filter(command => command.startsWith("pr ")), "EXPEDITE_GH_PR_CALLS").toEqual(["pr view", "pr ready", "pr view", "pr merge", "pr view"]);
  expect(h.calls.publish, "EXPEDITE_ACQUIRE_THEN_RELEASE").toEqual(["acquire", "release"]);
  expect(h.calls.publishRedMain, "EXPEDITE_RED_MAIN_WRITES").toEqual(["declare-fix", "expedite"]);
  expect(h.world.redMain.open?.expedited, "EXPEDITE_RECORDED").toEqual([expect.objectContaining({ pr: PR, squash: SQUASH, baseProbe: 301, headProbe: 302 })]);
  expect(h.calls.writes, "EXPEDITE_EVENT_FILE").toEqual([`/odysseus/checkout/tmp/expedited-fix-${PR}.json`]);
  expect(h.calls.runs.map(command => command.slice(1, 3)), "EXPEDITE_TIMINGS_RECORD").toEqual([[expect.stringMatching(/scripts\/ci-timings\.ts$/), "record"]]);
});
