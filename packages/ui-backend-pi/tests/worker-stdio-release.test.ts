/**
 * #2863: a pi turn, and a refused worker initialization, settle only once no
 * descriptor on the worker's stdio is open in the server, Bun's own duplicates
 * included. The real launcher runs a shell that speaks the worker protocol.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { holdWorkPool, ownedWorkerFifos } from "../../ui-sdk/tests/helpers/work-pool.js";
import { startFixtureTurn } from "../../../tests/fixtures/worker-input-fixture.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

/** Answers `init` with `ready`, waits, then reports the turn done. */
const ANSWERING = `IFS= read -r init
id=$(printf %s "$init" | grep -o '"sessionId":"[^"]*"' | tail -n 1 | cut -d '"' -f 4)
printf '{"type":"ready","sessionId":"%s","levels":[],"cost":0}\\n' "$id"
IFS= read -r prompt
sleep 0.3
printf '{"type":"done","cost":0}\\n'
printf 'Penelope' >&2`;
/** Reads `init`, then exits without answering it. */
const REFUSING = `IFS= read -r init; sleep 0.3; printf 'Penelope' >&2; exit 3`;

/**
 * The real pi turn on the real launcher, the worker's command replaced. Bun's
 * pool is held from when the last protocol line (`hold`) reached the worker's
 * FIFO, through the worker's teardown, and frees 250 ms after both its outputs end.
 */
async function piTurn(script: string, hold: "init" | "prompt" | "started" | "none", withheld?: { promise: Promise<void>; called(): void }) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-pi-release-"));
  const brain = join(root, "ithaca"), sessionDir = join(root, "sessions");
  mkdirSync(brain); mkdirSync(sessionDir);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  cleanup.push(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
  const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "governed", areas: [] });
  const fifos = ownedWorkerFifos();
  cleanup.push(fifos.restore);
  let pool: ReturnType<typeof holdWorkPool> | undefined;
  const real = worker.launchAgentWorkerAsync;
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async input => {
    const launched = await real({ ...input, command: ["/bin/sh", "-c", script] });
    if (withheld) {
      const released = launched.released;
      launched.released = () => { withheld.called(); return withheld.promise.then(released); };
    }
    if (hold === "started") {
      // Nothing reads the outputs of a worker whose start callback refused: they are closed instead.
      const held = pool = holdWorkPool(fifos.dir);
      const closed = (stream: NodeJS.ReadableStream) => new Promise(done => stream.once("close", done));
      void Promise.all([closed(launched.stdout), closed(launched.stderr)]).then(() => Bun.sleep(250)).then(held.release);
      return launched;
    }
    const write = launched.stdin.write.bind(launched.stdin) as (chunk: unknown, done: () => void) => boolean;
    launched.stdin.write = ((chunk: unknown) => write(chunk, () => {
      if (pool || hold === "none" || !String(chunk).includes(`"type":"${hold}"`)) return;
      const held = pool = holdWorkPool(fifos.dir);
      const ended = (stream: NodeJS.ReadableStream) => new Promise(done => stream.once("end", done));
      void Promise.all([ended(launched.stdout), ended(launched.stderr)]).then(() => Bun.sleep(250)).then(held.release);
    })) as typeof launched.stdin.write;
    return launched;
  });
  cleanup.push(async () => { await pool?.release(); launch.mockRestore(); });
  const backend = createPiBackend({ brainPath: brain, sessionDir, loadExtensions: false,
    profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }], confirmBashPatterns: [] });
  const frames: ServerMessage[] = [];
  const refused = await startFixtureTurn(backend, brain, { prompt: "Return to Ithaca", profileId: "fixture", signal: new AbortController().signal,
    turnId: "odysseus-release", workerSandbox: sandbox,
    ...(hold === "started" ? { workerStarted: () => { throw new Error("Odysseus scope freezer refused"); } } : {}),
    bridge: { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "deny", message: "fixture" }) } }).then(() => undefined, (error: unknown) => error as Error);
  return { open: fifos.held(), held: Boolean(pool), refused, result: frames.findLast(frame => frame.type === "result") };
}

const native = process.platform === "linux" && Boolean(Bun.which("bwrap"));

test.skipIf(!native)("a pi turn settles only once its worker's stdio descriptors are closed", async () => {
  const { open, held, refused, result } = await piTurn(ANSWERING, "prompt");
  expect(held, "POOL_HELD_THROUGH_TEARDOWN").toBe(true);
  expect(refused).toBeUndefined();
  expect(result?.type === "result" && result.outcome, "PI_TURN_COMPLETES").toBe("success");
  expect(open, "PI_TURN_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
});

test.skipIf(!native)("a refused pi worker initialization settles only once its stdio descriptors are closed", async () => {
  const { open, held, refused } = await piTurn(REFUSING, "init");
  expect(held, "POOL_HELD_THROUGH_TEARDOWN").toBe(true);
  expect(refused?.message, "PI_INIT_REFUSED").toBe("Pi worker exited before completion: Penelope");
  expect(open, "PI_INIT_REFUSAL_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
});

test.skipIf(!native)("a pi worker whose start callback refused settles only once its stdio descriptors are closed", async () => {
  const { open, held, refused } = await piTurn("sleep 30", "started");
  expect(held, "POOL_HELD_THROUGH_TEARDOWN").toBe(true);
  expect(refused?.message, "PI_START_REFUSED").toBe("Odysseus scope freezer refused");
  expect(open, "PI_START_REFUSAL_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
});

test.skipIf(!native)("a pi turn waits for its worker's stdio release, however long Bun takes within the bound", async () => {
  const release = Promise.withResolvers<void>();
  const calling = Promise.withResolvers<void>();
  let settled = false;
  const turn = piTurn(ANSWERING, "none", { promise: release.promise, called: calling.resolve }).then(outcome => { settled = true; return outcome; });
  cleanup.push(() => release.resolve());
  expect(await Promise.race([calling.promise.then(() => true), Bun.sleep(10_000).then(() => false)]), "PI_TURN_REACHES_RELEASE").toBe(true);
  await Bun.sleep(100);
  expect(settled, "PI_TURN_PENDING_WHILE_RELEASE_WITHHELD").toBe(false);
  release.resolve();
  const { open, refused, result } = await turn;
  expect(refused).toBeUndefined();
  expect(result?.type === "result" && result.outcome, "PI_TURN_COMPLETES").toBe("success");
  expect(open, "PI_TURN_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
});
