/**
 * #2863: a streaming maintenance launch frees its output slot and gate hold
 * only once no descriptor on its worker's stdio is open in the server, Bun's
 * own duplicates included, and never makes its caller drain the streams before
 * it reports the exit.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as maintenanceWorker from "../../ui-sdk/src/server/maintenance-worker.js";
import { createUiDb } from "../src/db/client.js";
import { createFixtureHostExecution as createHostExecution } from "./helpers/native-host-fixture.js";
import { holdWorkPool, ownedWorkerFifos } from "../../ui-sdk/tests/helpers/work-pool.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-launch-release-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain");
  mkdirSync(brain);
  writeFileSync(join(brain, "harbor.md"), "Odysseus at the harbour.\n");
  const db = createUiDb(join(root, "ui.db"));
  const execution = createHostExecution({ brainPath: brain, dbPath: join(root, "ui.db"), exec: {} });
  execution.attach(db);
  cleanup.push(() => db.close());
  return execution;
}

const program = (delayMs: number) => `await Bun.sleep(${delayMs}); process.stdout.write("Ithaca"); process.stderr.write("Penelope");`;
const launchArgs = (delayMs: number) => ({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program(delayMs)], env: {},
  credentials: false as const, gate: "exclusive" as const, purpose: "stdio release proof" });
const refusal = (work: Promise<unknown>) => work.then(() => undefined, (error: unknown) => error);

test("a streaming maintenance launch frees its gate only once its worker's stdio descriptors are closed", async () => {
  const execution = fixture();
  const fifos = ownedWorkerFifos();
  cleanup.push(fifos.restore);
  let pool: ReturnType<typeof holdWorkPool> | undefined;
  const worker = await execution.boundary.launch(launchArgs(300));
  try {
    // The pool is held from the end of the launch, through the worker's teardown, and frees only after it.
    const held = pool = holdWorkPool(fifos.dir);
    const outputs = Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    void outputs.then(() => Bun.sleep(250)).then(held.release);
    expect(await worker.exited, "LAUNCH_EXITS").toBe(0);
    expect(await outputs, "LAUNCH_OUTPUT_DRAINED").toEqual(["Ithaca", "Penelope"]);
    const next = await execution.gate()!.acquire("exclusive", "after the launch", { signal: AbortSignal.timeout(10_000) });
    const open = fifos.held();
    next.release();
    expect(open, "LAUNCH_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
  } finally { await pool?.release(); worker.kill("SIGKILL"); }
});

test("a caller that drains the streams only after the exit sees the exit first, and the gate frees once their stdio is released", async () => {
  const execution = fixture();
  const fifos = ownedWorkerFifos();
  cleanup.push(fifos.restore);
  const release = Promise.withResolvers<void>();
  let releasing = false;
  const real = maintenanceWorker.launchMaintenanceWorkerAsync;
  const launch = spyOn(maintenanceWorker, "launchMaintenanceWorkerAsync").mockImplementation(async input => {
    const launched = await real(input);
    const released = launched.released;
    return { ...launched, released: () => { releasing = true; return release.promise.then(released); } };
  });
  cleanup.push(() => { release.resolve(); launch.mockRestore(); });
  const worker = await execution.boundary.launch(launchArgs(0));
  try {
    // Nothing reads either stream before the exit is reported, and the release has not resolved.
    const exit = await Promise.race([worker.exited, Bun.sleep(10_000).then(() => "no exit")]);
    expect(exit, "EXIT_REPORTED_WHILE_RELEASE_PENDING").toBe(0);
    expect(await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text()]), "POST_EXIT_DRAIN_COMPLETES").toEqual(["Ithaca", "Penelope"]);
    let settled = false;
    void worker.settled?.then(() => { settled = true; });
    const early = await refusal(execution.gate()!.acquire("exclusive", "before the release", { signal: AbortSignal.timeout(200) }));
    expect({ releasing, early: early instanceof DOMException, settled }, "GATE_HELD_UNTIL_STDIO_RELEASE").toEqual({ releasing: true, early: true, settled: false });
    release.resolve();
    await worker.settled;
    // Settled means the gate is already free.
    const next = await execution.gate()!.acquire("exclusive", "after the release", { signal: AbortSignal.timeout(200) });
    const open = fifos.held();
    next.release();
    expect(open, "POST_EXIT_DRAIN_RELEASES_STDIO").toEqual([]);
  } finally { worker.kill("SIGKILL"); }
});
