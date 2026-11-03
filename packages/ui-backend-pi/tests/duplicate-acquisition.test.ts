/**
 * #2918: two concurrent resumes of one non-resident session through the public
 * `startTurn` each launch a real worker; the later return loses the pool race.
 * Pins reachability and the contracts a repair must keep: the winner's normal
 * result, a per-session busy refusal with no frames, and only the loser stopped.
 * #3488: the refusal settles only after the loser's worker has exited, its turn
 * temp is closed and its stdio release is awaited; a refused close is reported
 * without replacing the refusal and stays retryable.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { BackendBusyError, type ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend, type PiSessionLike } from "../src/backend.js";
import * as sessions from "../src/worker-session.js";
import { savePiSession } from "../src/session-storage.js";
import { prepareFixtureWorkerSandbox } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { ownedWorkerFifos } from "../../ui-sdk/tests/helpers/work-pool.js";
import { startFixtureTurn } from "../../../tests/fixtures/worker-input-fixture.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
const ID = "22222222-2222-4222-8222-222222222222";
const native = process.platform === "linux" && Boolean(Bun.which("bwrap"));

/** A credential-free protocol peer: ready on init, done once its prompt arrives. */
const ANSWERING = `IFS= read -r init
id=$(printf %s "$init" | grep -o '"sessionId":"[^"]*"' | tail -n 1 | cut -d '"' -f 4)
printf '{"type":"ready","sessionId":"%s","levels":[],"cost":0}\\n' "$id"
IFS= read -r prompt
printf '{"type":"done","cost":0}\\n'`;

interface Launched {
  root: unknown; exited: Promise<number>; hasExited: boolean; kills: number; closes: number; releases: number; released: number; prompts: number;
  refuseClose: boolean; session?: PiSessionLike;
}

for (const refused of [false, true]) test.skipIf(!native)(`a concurrent duplicate resume reaches the pool race with two real workers and refuses only the loser after its ${refused ? "refused" : "confirmed"} teardown`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-pi-duplicate-"));
  const brain = join(root, "ithaca"), sessionDir = join(root, "sessions");
  mkdirSync(brain); mkdirSync(sessionDir);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  cleanup.push(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const fifos = ownedWorkerFifos();
  cleanup.push(fifos.restore);
  savePiSession(sessionDir, ID, [{ type: "session", version: 3, id: ID, cwd: brain, timestamp: "2026-07-12T00:00:00.000Z" }]);
  const options = { brainPath: brain, sessionDir, loadExtensions: false,
    profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" as const }], confirmBashPatterns: [] };
  const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "governed", areas: [] });
  const warnings: string[] = [];
  const log = (level: string, message: string) => { if (level === "warn") warnings.push(message); };
  const cleanupRefusal = Object.assign(new Error("worker_identity_cleanup_unconfirmed: Odysseus fixture"), { cleanupUnconfirmed: true });
  const baseline = worker.processStateLedger().turnTempHeld;

  const workers: Launched[] = [];
  const realLaunch = worker.launchAgentWorkerAsync;
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async input => {
    const child = await realLaunch({ ...input, command: ["/bin/sh", "-c", ANSWERING] });
    const record: Launched = { root: child.turnTemp?.root, exited: child.exited, hasExited: false, kills: 0, closes: 0, releases: 0, released: 0, prompts: 0, refuseClose: false };
    void child.exited.then(() => { record.hasExited = true; });
    workers.push(record);
    const kill = child.kill.bind(child), release = child.released.bind(child), turnTemp = child.turnTemp;
    child.kill = signal => { record.kills++; return kill(signal); };
    child.released = async () => { record.releases++; await release(); record.released++; };
    if (turnTemp) child.turnTemp = Object.assign(Object.create(Object.getPrototypeOf(turnTemp)), turnTemp,
      { closeAsync: async () => { record.closes++; if (record.refuseClose) throw cleanupRefusal; return turnTemp.closeAsync(); } });
    return child;
  });
  // Both acquisitions hold a ready worker before either returns to the pool;
  // each is told apart by its own turn's signal, which the pool hands the worker.
  const signals = { winner: new AbortController().signal, loser: new AbortController().signal };
  const gate = () => ({ opened: Promise.withResolvers<void>(), returns: Promise.withResolvers<void>(), record: undefined as Launched | undefined });
  const gates = new Map([[signals.winner, gate()], [signals.loser, gate()]]);
  const winnerPrompted = Promise.withResolvers<void>(), finishWinner = Promise.withResolvers<void>();
  const realOpen = sessions.openPiWorkerSession;
  const opening = spyOn(sessions, "openPiWorkerSession").mockImplementation(async (...args) => {
    const own = gates.get(args[2].workerSignal!)!;
    const result = await realOpen(...args);
    // The launch that owns this session, by the turn-temp root it handed the turn context.
    const record = own.record = workers.find(entry => entry.root !== undefined && entry.root === result.turnContext.turnTemp?.root())!;
    record.session = result.session;
    const prompt = result.session.prompt.bind(result.session);
    result.session.prompt = async (...input) => {
      record.prompts++; winnerPrompted.resolve(); await finishWinner.promise; return prompt(...input);
    };
    own.opened.resolve();
    await own.returns.promise;
    return result;
  });
  const backend = createPiBackend({ ...options, log });
  const turn = (signal: AbortSignal, frames: ServerMessage[]) => startFixtureTurn(backend, brain, { prompt: "Return to Ithaca", profileId: "fixture",
    sessionId: ID, signal, workerSandbox: sandbox,
    bridge: { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "deny", message: "Odysseus fixture" }) } });
  const winnerFrames: ServerMessage[] = [], loserFrames: ServerMessage[] = [];
  const winning = turn(signals.winner, winnerFrames).then(() => undefined, error => error);
  const losing = turn(signals.loser, loserFrames).then(() => undefined, error => error);
  cleanup.push(async () => {
    for (const own of gates.values()) own.returns.resolve();
    for (const record of workers) record.refuseClose = false;
    finishWinner.resolve();
    await winning; await losing;
    // Release whatever a still-synchronous loser disposal left reserved.
    for (const record of workers) await record.session?.abort().catch(() => {});
    opening.mockRestore(); launch.mockRestore();
  });

  await Promise.all([...gates.values()].map(own => own.opened.promise));
  expect(workers, "PI_DUPLICATE_RESUME_LAUNCHES_TWO_WORKERS").toHaveLength(2);
  expect(new Set(workers.map(entry => entry.root)).size, "PI_DUPLICATE_RESUME_DISTINCT_LAUNCHES").toBe(2);
  const winner = gates.get(signals.winner)!.record!, loser = gates.get(signals.loser)!.record!;
  expect(winner.session!.sessionId).toBe(ID);
  expect(loser.session!.sessionId).toBe(ID);
  expect(winner.session, "PI_DUPLICATE_RESUME_OWNS_DISTINCT_WORKERS").not.toBe(loser.session);
  const bothHeld = worker.processStateLedger().turnTempHeld - baseline;
  expect(bothHeld, "PI_DUPLICATE_RESUME_BOTH_RESERVED").toBeGreaterThan(0);
  loser.refuseClose = refused;

  // The first acquisition to return wins the pool; the other loses the race.
  gates.get(signals.winner)!.returns.resolve();
  await winnerPrompted.promise;
  gates.get(signals.loser)!.returns.resolve();
  const refusal = await losing;
  expect(refusal, "PI_DUPLICATE_RESUME_LOSER_REFUSES_BUSY").toBeInstanceOf(BackendBusyError);
  expect(loserFrames, "PI_DUPLICATE_RESUME_LOSER_EMITS_NO_FRAMES").toEqual([]);
  expect(loser.prompts, "PI_DUPLICATE_RESUME_LOSER_NEVER_PROMPTS").toBe(0);
  expect(winner.kills, "PI_DUPLICATE_RESUME_WINNER_NOT_STOPPED_BY_LOSER").toBe(0);
  expect(winner.hasExited, "PI_DUPLICATE_RESUME_WINNER_STILL_RUNNING").toBe(false);
  expect(loser.kills, "PI_DUPLICATE_RESUME_LOSER_IS_STOPPED").toBeGreaterThan(0);
  // #3488: the refusal settles only after the loser's own teardown has finished.
  expect(loser.hasExited, "PI_DUPLICATE_RESUME_LOSER_EXITED_BEFORE_REFUSAL").toBe(true);
  expect(loser.closes, "PI_DUPLICATE_RESUME_LOSER_CLOSED_BEFORE_REFUSAL").toBe(1);
  expect(loser.releases, "PI_DUPLICATE_RESUME_LOSER_RELEASE_REQUESTED_BEFORE_REFUSAL").toBe(1);
  expect(loser.released, "PI_DUPLICATE_RESUME_LOSER_RELEASE_AWAITED_BEFORE_REFUSAL").toBe(1);
  const held = worker.processStateLedger().turnTempHeld - baseline;
  if (refused) {
    expect(held, "PI_DUPLICATE_RESUME_REFUSED_LOSER_KEEPS_RESERVATION").toBe(bothHeld);
    expect(warnings.filter(message => message.includes(cleanupRefusal.message)), "PI_DUPLICATE_RESUME_REFUSED_LOSER_CLEANUP_REPORTED").toHaveLength(1);
  } else {
    expect(held, "PI_DUPLICATE_RESUME_LEDGER_CHARGES_ONLY_WINNER").toBe(bothHeld / 2);
    expect(warnings, "PI_DUPLICATE_RESUME_CONFIRMED_LOSER_NO_WARNING").toEqual([]);
  }
  expect(winner.kills, "PI_DUPLICATE_RESUME_WINNER_NOT_STOPPED_BY_LOSER_TEARDOWN").toBe(0);
  expect(winner.hasExited, "PI_DUPLICATE_RESUME_WINNER_RUNNING_AFTER_LOSER_TEARDOWN").toBe(false);
  if (refused) {
    // The shared abort can retry the refused close and release the reservation.
    loser.refuseClose = false;
    await loser.session!.abort();
    expect(loser.closes, "PI_DUPLICATE_RESUME_REFUSED_LOSER_RETRIES_CLOSE").toBe(2);
    expect(worker.processStateLedger().turnTempHeld - baseline, "PI_DUPLICATE_RESUME_RETRY_RELEASES_LOSER_RESERVATION").toBe(bothHeld / 2);
  }

  finishWinner.resolve();
  expect(await winning, "PI_DUPLICATE_RESUME_WINNER_SETTLES_NORMALLY").toBeUndefined();
  expect(winnerFrames.filter(frame => frame.type === "result" || frame.type === "error"), "PI_DUPLICATE_RESUME_WINNER_RESULT")
    .toEqual([expect.objectContaining({ type: "result", sessionId: ID, outcome: "success", isError: false })]);
  expect(winner.prompts).toBe(1);
  expect(winner.closes, "PI_DUPLICATE_RESUME_WINNER_CLOSES_TURN_TEMP").toBe(1);
  expect(winner.releases, "PI_DUPLICATE_RESUME_WINNER_RELEASES_STDIO").toBeGreaterThan(0);
  await loser.exited;
  expect(loser.hasExited, "PI_DUPLICATE_RESUME_LOSER_EXITS").toBe(true);
  expect(loser.closes, "PI_DUPLICATE_RESUME_LOSER_CLOSES_ONCE_PER_ATTEMPT").toBe(refused ? 2 : 1);
  expect(worker.processStateLedger().turnTempHeld, "PI_DUPLICATE_RESUME_RELEASES_ALL_RESERVATIONS").toBe(baseline);
});
