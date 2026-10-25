/** #2880: cancellation before prompt owns the same teardown as a prompted turn. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend, type PiSessionLike } from "../src/backend.js";
import * as sessions from "../src/worker-session.js";
import { savePiSession } from "../src/session-storage.js";
import { prepareFixtureWorkerSandbox } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { ownedWorkerFifos } from "../../ui-sdk/tests/helpers/work-pool.js";
import { startFixtureTurn } from "../../../tests/fixtures/worker-input-fixture.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
const ID = "11111111-1111-4111-8111-111111111111";
const native = process.platform === "linux" && Boolean(Bun.which("bwrap"));

/** The real launcher runs this credential-free protocol peer until the test kills it. */
const WAITING = `IFS= read -r init
id=$(printf %s "$init" | grep -o '"sessionId":"[^"]*"' | tail -n 1 | cut -d '"' -f 4)
printf '{"type":"ready","sessionId":"%s","levels":[],"cost":0}\\n' "$id"
IFS= read -r prompt
sleep 30`;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-pi-cancel-"));
  const brain = join(root, "ithaca"), sessionDir = join(root, "sessions");
  mkdirSync(brain); mkdirSync(sessionDir);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  cleanup.push(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const fifos = ownedWorkerFifos();
  cleanup.push(fifos.restore);
  const options = { brainPath: brain, sessionDir, loadExtensions: false,
    profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" as const }], confirmBashPatterns: [] };
  const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "governed", areas: [] });
  return { root, brain, sessionDir, fifos, options, sandbox };
}

/** A negative observation: the real runner gets a native event-loop opportunity to settle. */
async function pending(turn: { settled: boolean }, frames: ServerMessage[], assertion: string) {
  await Bun.sleep(50);
  expect(turn.settled, assertion).toBe(false);
  expect(frames.filter(frame => frame.type === "result" || frame.type === "error"), assertion).toEqual([]);
}

for (const phase of ["new acquisition", "resumed acquisition", "before prompt"] as const) for (const refused of [false, true]) {
  test.skipIf(!native)(`pi cancellation during ${phase} waits for exit, ${refused ? "refused" : "confirmed"} cleanup and stdio release`, async () => {
    const { root, brain, sessionDir, fifos, options, sandbox } = await fixture();
    if (phase === "resumed acquisition") savePiSession(sessionDir, ID, [
      { type: "session", version: 3, id: ID, cwd: brain, timestamp: "2026-07-12T00:00:00.000Z" },
    ]);
    const controller = new AbortController();
    const acquired = Promise.withResolvers<void>(), returnSession = Promise.withResolvers<void>();
    const killed = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
    const releasing = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const frames: ServerMessage[] = [], turn = { settled: false };
    const baseline = worker.processStateLedger().turnTempHeld;
    let exitWorker: (() => unknown) | undefined, exited: Promise<number> | undefined;
    let workerExited = false, closeCalls = 0, releaseCalls = 0, promptCalls = 0;
    let refuseClose = refused;
    const cleanupRefusal = Object.assign(new Error("worker_identity_cleanup_unconfirmed: Odysseus fixture"), { cleanupUnconfirmed: true });
    let session: PiSessionLike | undefined;
    const realLaunch = worker.launchAgentWorkerAsync;
    const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async input => {
      const child = await realLaunch({ ...input, command: ["/bin/sh", "-c", WAITING] });
      exited = child.exited.then(code => { workerExited = true; return code; });
      const kill = child.kill.bind(child), release = child.released.bind(child), turnTemp = child.turnTemp;
      exitWorker = () => kill("SIGKILL");
      // Hold the owned real process alive after cancellation's signal request.
      child.kill = () => { killed.resolve(); };
      child.turnTemp = { root, space: () => ({ total: 0, free: 0 }), close() { throw new Error("PI_SYNC_CLOSE_ON_ASYNC_LIFECYCLE"); },
        async closeAsync() { closeCalls++; closing.resolve(); await closed.promise; if (refuseClose) throw cleanupRefusal; await turnTemp?.closeAsync(); } };
      child.released = async () => { releaseCalls++; releasing.resolve(); await released.promise; await release(); };
      return child;
    });
    const realOpen = sessions.openPiWorkerSession;
    const opening = spyOn(sessions, "openPiWorkerSession").mockImplementation(async (...args) => {
      const opened = await realOpen(...args);
      session = opened.session;
      const prompt = session.prompt.bind(session);
      session.prompt = (...input) => { promptCalls++; return prompt(...input); };
      acquired.resolve();
      if (phase !== "before prompt") await returnSession.promise;
      return opened;
    });
    const backend = createPiBackend(options);
    const running = startFixtureTurn(backend, brain, { prompt: "Return to Ithaca", profileId: "fixture", signal: controller.signal,
      ...(phase === "resumed acquisition" ? { sessionId: ID } : {}), workerSandbox: sandbox,
      bridge: { emit: frame => { frames.push(frame); if (phase === "before prompt" && frame.type === "session_info") controller.abort(); },
        requestPermission: async () => ({ behavior: "deny", message: "Odysseus fixture" }) } });
    const outcome = running.then(() => { turn.settled = true; return undefined; }, error => { turn.settled = true; return error; });
    cleanup.push(async () => {
      refuseClose = false; returnSession.resolve(); closed.resolve(); released.resolve(); exitWorker?.();
      await exited; await outcome; await session?.abort(); opening.mockRestore(); launch.mockRestore();
    });
    await acquired.promise;
    if (phase !== "before prompt") { controller.abort(); returnSession.resolve(); }
    await killed.promise;
    expect(workerExited, "PI_CANCEL_FIXTURE_WORKER_STILL_RUNNING").toBe(false);
    await pending(turn, frames, "PI_EARLY_CANCEL_PENDING_UNTIL_WORKER_EXIT");
    expect(closeCalls, "PI_EARLY_CANCEL_DOES_NOT_CLOSE_LIVE_WORKER").toBe(0);
    // The event handler's abort and these callers must join the runner's abort.
    const aborts = [session!.abort(), session!.abort()];
    const joined = Promise.all(aborts).then(() => "resolved", error => error);
    let joinedSettled = false;
    void joined.then(() => { joinedSettled = true; });
    exitWorker!(); await exited; await closing.promise;
    expect(workerExited, "PI_EARLY_CANCEL_OBSERVED_REAL_EXIT").toBe(true);
    await pending(turn, frames, "PI_EARLY_CANCEL_PENDING_UNTIL_CLEANUP");
    expect(releaseCalls, "PI_EARLY_CANCEL_CLEANUP_PRECEDES_STDIO_RELEASE").toBe(0);
    expect(joinedSettled, "PI_REPEATED_ABORT_JOINS_CLEANUP").toBe(false);
    expect(worker.processStateLedger().turnTempHeld, "PI_EARLY_CANCEL_RETAINS_RESERVATION").toBeGreaterThan(baseline);
    closed.resolve(); await Promise.race([releasing.promise, outcome]);
    await pending(turn, frames, "PI_EARLY_CANCEL_PENDING_UNTIL_STDIO_RELEASE");
    expect(joinedSettled, "PI_REPEATED_ABORT_JOINS_STDIO_RELEASE").toBe(false);
    released.resolve();
    expect(await outcome, "PI_EARLY_CANCEL_SETTLES_NORMALLY").toBeUndefined();
    expect(await joined, "PI_REPEATED_ABORT_SHARES_CLEANUP_OUTCOME").toBe(refused ? cleanupRefusal : "resolved");
    expect(closeCalls, "PI_EARLY_CANCEL_CLOSES_ONCE").toBe(1);
    expect(releaseCalls, "PI_EARLY_CANCEL_RELEASES_ONCE").toBe(1);
    expect(promptCalls, "PI_EARLY_CANCEL_NEVER_PROMPTS").toBe(0);
    if (refused) {
      expect(worker.processStateLedger().turnTempHeld, "PI_REFUSED_EARLY_CANCEL_KEEPS_RESERVATION").toBeGreaterThan(baseline);
      refuseClose = false;
      await session!.abort();
      expect(closeCalls, "PI_REFUSED_EARLY_CANCEL_RETRIES_CLOSE").toBe(2);
    }
    expect(worker.processStateLedger().turnTempHeld, "PI_EARLY_CANCEL_RELEASES_RESERVATION").toBe(baseline);
    expect(fifos.held(), "PI_EARLY_CANCEL_NO_WORKER_FIFO_DESCRIPTORS").toEqual([]);
    const terminals = frames.filter(frame => frame.type === "result" || frame.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject(phase === "new acquisition"
      ? { type: "error", code: "agent_error", message: "The turn was cancelled before a session was acquired." }
      : { type: "result", outcome: "cancelled", isError: false });
  });
}

test.skipIf(!native)("pre-prompt cancellation preserves the real five-second stdio release bound", async () => {
  const { brain, fifos, options, sandbox } = await fixture();
  const controller = new AbortController(), frames: ServerMessage[] = [], turn = { settled: false };
  const reached = Promise.withResolvers<void>(), begin = Promise.withResolvers<void>(), waiting = Promise.withResolvers<void>();
  let retained: number | undefined, release: (() => Promise<void>) | undefined;
  let now = 1_000;
  let clock: ReturnType<typeof spyOn> | undefined;
  const real = worker.launchAgentWorkerAsync;
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async input => {
    const child = await real({ ...input, command: ["/bin/sh", "-c", WAITING] });
    // Retain a test-owned FIFO reference after the real worker and all its streams exit.
    const fd = readdirSync("/proc/self/fd").find(fd => {
      try { const target = readlinkSync(`/proc/self/fd/${fd}`); return target.startsWith(join(fifos.dir, "brain-worker-pipes-")) && target.endsWith("/stdin (deleted)"); }
      catch { return false; }
    });
    expect(fd, "PI_BOUND_FIXTURE_RETAINS_REAL_FIFO").toBeDefined();
    retained = openSync(`/proc/self/fd/${fd}`, constants.O_RDWR | constants.O_NONBLOCK);
    release = child.released.bind(child);
    child.released = async () => {
      reached.resolve(); await begin.promise;
      clock = spyOn(performance, "now").mockImplementation(() => now);
      const finishing = release!(); waiting.resolve(); await finishing;
    };
    return child;
  });
  const running = startFixtureTurn(createPiBackend(options), brain, { prompt: "Return to Ithaca", profileId: "fixture", signal: controller.signal, workerSandbox: sandbox,
    bridge: { emit: frame => { frames.push(frame); if (frame.type === "session_info") controller.abort(); }, requestPermission: async () => ({ behavior: "deny", message: "Odysseus fixture" }) } });
  const outcome = running.then(() => { turn.settled = true; }, error => { turn.settled = true; throw error; });
  cleanup.push(async () => {
    now = 6_000; begin.resolve(); if (retained !== undefined) { closeSync(retained); retained = undefined; }
    await outcome; clock?.mockRestore(); launch.mockRestore();
  });
  await reached.promise; begin.resolve(); await waiting.promise;
  await pending(turn, frames, "PI_RELEASE_BOUND_PENDING_AT_ZERO");
  now = 5_999;
  await pending(turn, frames, "PI_RELEASE_BOUND_PENDING_BEFORE_FIVE_SECONDS");
  now = 6_000; await outcome;
  clock!.mockRestore();
  expect(fifos.held().length, "PI_RELEASE_BOUND_EXPIRES_WITH_UNCONFIRMED_DESCRIPTOR").toBeGreaterThan(0);
  expect(frames.find(frame => frame.type === "result")).toMatchObject({ outcome: "cancelled", isError: false });
});

for (const failure of ["startup failure", "initialization timeout"] as const) {
  test.skipIf(!native)(`cancellation during stdio release preserves ${failure}`, async () => {
    const { brain, options, sandbox } = await fixture();
    const controller = new AbortController(), frames: ServerMessage[] = [];
    const reached = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<() => void>();
    const nativeSetTimeout = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = nativeSetTimeout(callback, delay, ...args);
      if (delay === 30_000 && new Error().stack?.includes("/src/worker-session.ts:")) deadline.resolve(() => callback(...args));
      return handle;
    }) as typeof globalThis.setTimeout);
    const real = worker.launchAgentWorkerAsync;
    const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async input => {
      const script = failure === "startup failure"
        ? `IFS= read -r init; printf '{"type":"error","message":"Odysseus refused the voyage"}\\n'; sleep 30`
        : "IFS= read -r init; sleep 30";
      const child = await real({ ...input, command: ["/bin/sh", "-c", script] });
      const release = child.released.bind(child);
      child.released = async () => { reached.resolve(); await released.promise; await release(); };
      return child;
    });
    let settled = false;
    const running = startFixtureTurn(createPiBackend(options), brain, { prompt: "Return to Ithaca", profileId: "fixture", signal: controller.signal, workerSandbox: sandbox,
      bridge: { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "deny", message: "Odysseus fixture" }) } });
    const outcome = running.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    cleanup.push(async () => { released.resolve(); await outcome; launch.mockRestore(); timers.mockRestore(); });
    const timeout = await deadline.promise;
    if (failure === "initialization timeout") timeout();
    await reached.promise;
    controller.abort();
    await Bun.sleep(50);
    expect(settled, "PI_START_FAILURE_AWAITS_RELEASE_DESPITE_CANCELLATION").toBe(false);
    released.resolve();
    expect((await outcome)?.message, "PI_START_FAILURE_NOT_REPLACED_BY_LATE_CANCELLATION").toBe(failure === "startup failure"
      ? "Odysseus refused the voyage" : "Pi worker initialization timed out");
    expect(frames, "PI_START_FAILURE_HAS_NO_SYNTHETIC_CANCELLED_RESULT").toEqual([]);
  });
}
