import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { MaintenanceTempBusyError, reserveMaintenanceTemp, type MaintenanceCommand, type MaintenanceTempReservation } from "@schlessera/brain-ui-sdk/internal";
import type { ReferenceToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createReferenceSources } from "../src/brain/reference-source";
import { createReferenceTransport } from "../src/brain/reference-transport";
import { createReferenceTools } from "../src/brain/reference-tools";
import { referencePoolDouble } from "./helpers/reference-pool-double";

// #4079: a turn's first reference_source call shares one maintenance budget
// with that turn's own maintenance commands, such as its scratch check.
// Production limits: one 256 MiB allowance in a 256 MiB budget, so two
// commands never overlap. A private shared-state domain keeps this ledger
// apart from every other test's.
const LIMITS = { allowanceBytes: 268435456, budgetBytes: 268435456 };
/** The stated bound: each reference Git command waits at most this long for admission (`REFERENCE_ADMISSION_WAIT_MS`). */
const BOUND_MS = 30_000;
const BRAIN = "ithaca-brain", PUBLIC = "https://github.com/odysseus/ithaca", TIP = "1".repeat(40);
let root: string, db: Database, domain: { statePath: string };
const held: MaintenanceTempReservation[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-reference-admission-")));
  mkdirSync(join(root, "brain")); mkdirSync(join(root, "state"));
  domain = { statePath: join(root, "state", "ui.db") };
  db = createUiDb(":memory:");
});
afterEach(() => {
  for (const reservation of held.splice(0)) reservation.release();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * The transport's launcher, taking the real maintenance admission before
 * launch as `runMaintenanceWorker` does, with the limits, domain and kind the
 * transport names. Admission is the only part under test: no worker starts,
 * and each Git command answers as the fixture repository would.
 */
function admittingRun(launches: string[], afterStep?: (step: string) => void) {
  return async (command: MaintenanceCommand & { signal?: AbortSignal }) => {
    const step = ["ls-remote", "fetch", "rev-parse", "checkout"].find(name => command.command.includes(name))!;
    let reservation: MaintenanceTempReservation;
    try { reservation = reserveMaintenanceTemp(command.tempLimits!, command.tempDomain, command.tempKind); }
    catch (error) { launches.push(`${step}:refused`); throw error; }
    launches.push(`${step}:admitted`);
    try {
      if (step === "ls-remote") return { stdout: `${TIP}\trefs/heads/main\n`, stderr: "", exitCode: 0, killed: false };
      if (step === "rev-parse") return { stdout: `${TIP}\n`, stderr: "", exitCode: 0, killed: false };
      if (step === "checkout") writeFileSync(join(command.transport!.mirror, "odyssey.md"), "Sing, Muse, of the man of many ways.\n");
      return { stdout: "", stderr: "", exitCode: 0, killed: false };
    } finally { reservation.release(); afterStep?.(step); }
  };
}

/** One app's reference service over the real transport, and one interactive turn prepared as admission prepares it. */
async function turn(options: { admissionWaitMs?: number; afterStep?: (step: string) => void } = {}) {
  const launches: string[] = [];
  const transport = createReferenceTransport({ brainPath: join(root, "brain"), tempLimits: LIMITS, tempDomain: domain, run: admittingRun(launches, options.afterStep) as never,
    ...(options.admissionWaitMs !== undefined ? { admissionWaitMs: options.admissionWaitMs } : {}) });
  const sources = createReferenceSources({ db, pool: referencePoolDouble(join(root, "pool")), transport, brain: BRAIN, credentials: {} });
  const tools = createReferenceTools({ sources });
  const principalId = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 86_400 }).id;
  const turnId = crypto.randomUUID();
  expect(await tools.begin(turnId, { principalId, posture: "interactive", generation: null }), "REFERENCE_TURN_BINDS_ITS_VIEWS").not.toBeNull();
  const call = () => tools.call(turnId, principalId, { tool: "reference_source", input: { repository: PUBLIC, revision: "main" } });
  return { call, launches };
}
/** What holds the budget when the turn's first call starts: its own scratch check. */
const scratchCheck = () => { const reservation = reserveMaintenanceTemp(LIMITS, domain, "scratch_query"); held.push(reservation); return reservation; };

test("a turn's first reference_source call waits for the turn's own scratch check, then succeeds", async () => {
  const check = scratchCheck();
  const { call, launches } = await turn();
  const started = performance.now();
  const answer = call();
  // The scratch check finishes 250 ms into the call, as a short git query does.
  await Bun.sleep(250);
  expect(launches, "REFERENCE_CALL_WAS_REFUSED_WHILE_THE_SCRATCH_CHECK_HELD").toEqual(["ls-remote:refused"]);
  check.release();
  const result: ReferenceToolResult = await answer;
  const elapsed = performance.now() - started;
  expect(result, "REFERENCE_CALL_SUCCEEDS_ONCE_THE_SCRATCH_CHECK_FINISHES").toMatchObject({ ok: true, source: { repository: PUBLIC, commit: TIP } });
  expect(elapsed, "REFERENCE_CALL_IS_ADMITTED_WITHIN_ITS_STATED_BOUND").toBeLessThan(BOUND_MS);
  expect(launches, "REFERENCE_CALL_RUNS_EVERY_GIT_COMMAND_AFTER_ITS_WAIT")
    .toEqual(["ls-remote:refused", "ls-remote:admitted", "fetch:admitted", "rev-parse:admitted", "checkout:admitted"]);
});

test("a reference_source call answers busy with retry guidance when maintenance stays held past its bound", async () => {
  scratchCheck();
  const { call, launches } = await turn({ admissionWaitMs: 300 });
  const started = performance.now();
  const result = await call();
  expect(result, "REFERENCE_CALL_PAST_ITS_BOUND_IS_BUSY_NOT_UNAVAILABLE").toMatchObject({ ok: false, code: "busy" });
  expect(result.ok === false && result.message, "REFERENCE_BUSY_REFUSAL_TELLS_THE_AGENT_TO_RETRY").toMatch(/nothing ran\. Retry this request/);
  expect(performance.now() - started, "REFERENCE_CALL_WAITS_ITS_BOUND_BEFORE_REFUSING").toBeGreaterThanOrEqual(290);
  expect(launches.every(launch => launch === "ls-remote:refused"), "REFERENCE_CALL_NEVER_RAN_A_COMMAND").toBe(true);
});

test("a fetch refused past its bound after a successful resolution is busy too, and nothing is published", async () => {
  // A longer maintenance command, such as an index, starts between the resolution and the fetch.
  const { call, launches } = await turn({ admissionWaitMs: 300, afterStep: step => { if (step === "ls-remote") held.push(reserveMaintenanceTemp(LIMITS, domain, "index")); } });
  const result = await call();
  expect(result, "REFERENCE_FETCH_PAST_ITS_BOUND_IS_BUSY_NOT_UNAVAILABLE").toMatchObject({ ok: false, code: "busy" });
  expect(launches.slice(0, 2), "REFERENCE_FETCH_WAS_REFUSED_AFTER_ITS_RESOLUTION").toEqual(["ls-remote:admitted", "fetch:refused"]);
  expect(launches, "REFERENCE_FETCH_NEVER_CHECKED_OUT").not.toContain("checkout:admitted");
});

test("a maintenance-busy refusal that reaches the tool unconverted is still busy", async () => {
  const principalId = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 86_400 }).id;
  scratchCheck();
  let busy: unknown;
  try { held.push(reserveMaintenanceTemp(LIMITS, domain, "git")); } catch (error) { busy = error; }
  expect(busy, "FIXTURE_HOLDS_A_REAL_BUSY_REFUSAL").toBeInstanceOf(MaintenanceTempBusyError);
  const tools = createReferenceTools({ sources: { bindable: async () => ({ public: "/views/public", private: "/views/private" }), request: async () => { throw busy; } } });
  await tools.begin("ithaca-turn", { principalId, posture: "interactive", generation: null });
  const result = await tools.call("ithaca-turn", principalId, { tool: "reference_source", input: { repository: PUBLIC, revision: "main" } });
  expect(result, "RAW_MAINTENANCE_BUSY_IS_A_BUSY_REFUSAL").toEqual({ ok: false, code: "busy", message: "Host maintenance is busy, so nothing ran. Retry this request in a minute." });
});
