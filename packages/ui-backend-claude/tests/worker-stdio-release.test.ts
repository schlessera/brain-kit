/**
 * #2863: a Claude worker settles only once no descriptor on its stdio is open
 * in the server, Bun's own duplicates included. Its exit is reported to the
 * SDK first, so nothing that drains output after the exit waits on that.
 */
import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { prepareWorkerSandbox, type LaunchedWorker } from "@schlessera/brain-ui-sdk/internal";
import { createWorkerSpawn } from "../src/worker-spawn.js";
import { createStateLedger } from "../src/worker-state-budget.js";
import { holdWorkPool, ownedWorkerFifos } from "../../ui-sdk/tests/helpers/work-pool.js";

const MiB = 1024 * 1024;
const limits = { allowanceBytes: 64 * MiB, budgetBytes: 192 * MiB };
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-worker-release-"));
  const brain = join(root, "brain"), saved = join(root, "config"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(saved); mkdirSync(home); writeFileSync(join(saved, "settings.json"), "{}");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const fifos = ownedWorkerFifos();
  cleanup.push(fifos.restore);
  const sandbox = prepareWorkerSandbox(brain, { home, profile: "governed", areas: [] });
  const ledger = createStateLedger();
  const spawner = (started: (worker: LaunchedWorker) => void) => createWorkerSpawn(brain, {}, new AbortController().signal, undefined, sandbox,
    undefined, undefined, { ledger, limits, turnTempLimits: { allowanceBytes: MiB, budgetBytes: MiB } }, undefined,
    worker => started(worker as LaunchedWorker));
  // The facade's stdin stays open, as the SDK's does until it closes its query after the turn.
  const spawn = (workers: ReturnType<typeof spawner>, script: string): SpawnedProcess => workers.spawn({ command: "/bin/sh", args: ["-c", script],
    env: { CLAUDE_CONFIG_DIR: saved, HOME: home }, signal: new AbortController().signal } as never);
  return { fifos, ledger, spawner, spawn };
}

test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))("a Claude worker settles only once its stdio descriptors are closed", async () => {
  const { fifos, ledger, spawner, spawn } = fixture();
  let pool: ReturnType<typeof holdWorkPool> | undefined;
  const workers = spawner(worker => {
    // The pool is held from the end of the launch, through the worker's teardown, and frees only after it.
    const held = pool = holdWorkPool(fifos.dir);
    void Promise.all([once(worker.stdout, "end"), once(worker.stderr, "end")]).then(() => Bun.sleep(250)).then(held.release);
  });
  cleanup.push(async () => { await pool?.release(); await workers.finish().catch(() => {}); });
  const child = spawn(workers, "sleep 0.3; printf Ithaca; printf Penelope >&2");
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  await workers.finish();
  const open = fifos.held();
  expect(output, "WORKER_OUTPUT_DELIVERED").toBe("Ithaca");
  expect(open, "WORKER_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
  expect(ledger.live).toBe(0);
});

test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))("a Claude worker reports its exit before its stdio release, and settles after it", async () => {
  const { fifos, spawner, spawn } = fixture();
  const release = Promise.withResolvers<void>();
  let releasing = false;
  const workers = spawner(worker => {
    const real = worker.released.bind(worker);
    worker.released = () => { releasing = true; return release.promise.then(real); };
  });
  cleanup.push(async () => { release.resolve(); await workers.finish().catch(() => {}); });
  const child = spawn(workers, "printf Ithaca; printf Penelope >&2");
  let settled = false;
  const finished = workers.finish().then(() => { settled = true; });
  const exited = new Promise<unknown[]>(done => child.once("exit", (code, signal) => done([code, signal])));
  const exit = await Promise.race([exited, Bun.sleep(10_000).then(() => "no exit")]);
  expect(exit, "EXIT_REPORTED_WHILE_RELEASE_PENDING").toEqual([0, null]);
  // Only after the exit does anything read the output.
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  await once(child.stdout, "end");
  expect(output, "POST_EXIT_DRAIN_COMPLETES").toBe("Ithaca");
  await Bun.sleep(50);
  expect({ releasing, settled }, "SETTLEMENT_WAITS_FOR_RELEASE").toEqual({ releasing: true, settled: false });
  release.resolve();
  await finished;
  expect(fifos.held(), "WORKER_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
});
