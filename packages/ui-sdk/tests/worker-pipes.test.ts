/**
 * #1648: a worker's output pipes are read without holding a thread. Node's fs
 * read streams park a thread-pool thread on every pending FIFO read, and the
 * pool is sized from the CPU count: on a four-CPU CI runner two idle workers
 * held all of it, and every other asynchronous file operation in the server,
 * a maintenance worker's own included, waited for a worker to speak.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { availableParallelism } from "node:os";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, read, readdirSync, readlinkSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as workerPipes from "../src/server/worker-pipes";
import { createWorkerPipes, createWorkerPipesSteps, fifoStream } from "../src/server/worker-pipes";
import { createWorkerStatusPipe, createWorkerStatusPipeSteps } from "../src/server/worker-status";
import { runWorkerStepsAsync } from "../src/server/worker-steps";
import { launchAgentWorkerAsync } from "../src/server/worker-launcher";
import { runMaintenanceWorker } from "../src/server/maintenance-worker";
import { createFixtureWorkerStartupView } from "./helpers/worker-startup-view-fixture.js";
import { mkfifoShim } from "./helpers/mkfifo-shim.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

test("many idle worker outputs leave asynchronous file I/O free", async () => {
  // Comfortably more pending reads than any CPU-sized pool holds.
  const workers = 8 * availableParallelism() + 16;
  for (let i = 0; i < workers; i++) {
    const pipes = createWorkerPipes();
    cleanups.push(() => pipes.closeChild());
    if (i % 2) {
      const { stdout, stderr } = pipes.streams();
      stdout.on("data", () => {}); stderr.on("data", () => {});
    } else {
      const ends = pipes.take();
      cleanups.push(() => closeSync(ends.stdin));
      for (const fd of [ends.stdout, ends.stderr]) void new Response(fifoStream(fd)).text();
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "worker-pipes-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const io = (async () => {
    await writeFile(join(dir, "harbor.md"), "Ithaca\n");
    return readFile(join(dir, "harbor.md"), "utf8");
  })();
  const stalled = new Promise<string>(resolve => setTimeout(() => resolve("stalled"), 5_000));
  expect(await Promise.race([io, stalled])).toBe("Ithaca\n");
});

// #2799: the asynchronous forms own their FIFOs as the synchronous ones do.

/** A private TMPDIR, so the FIFOs' directory and any descriptor still open on it are this test's alone. */
function ownedTmp() {
  const dir = mkdtempSync(join(tmpdir(), "worker-pipes-owned-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  return {
    /** FIFO directories left behind, and descriptors still open on anything below them. */
    remains: () => ({
      directories: readdirSync(dir).filter(name => name.startsWith("brain-worker-")),
      descriptors: readdirSync("/proc/self/fd").flatMap(fd => {
        try { const target = readlinkSync(`/proc/self/fd/${fd}`); return target.startsWith(dir) ? [target] : []; } catch { return []; }
      }),
    }),
    restore: () => {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Holds every thread of Bun's pool on a blocking FIFO read until `release`.
 * Bun's file streams and sinks close their duplicate descriptors on that pool
 * (#2862), so while it is held they stay open after their streams end.
 */
function holdWorkPool(dir: string) {
  const plug = join(dir, "pool-plug");
  if (Bun.spawnSync(["mkfifo", plug]).exitCode !== 0) throw new Error("mkfifo failed");
  const writer = openSync(plug, constants.O_RDWR);
  const reads = Array.from({ length: 8 * availableParallelism() + 16 }, () => {
    const fd = openSync(plug, constants.O_RDONLY);
    return new Promise<void>(done => read(fd, Buffer.alloc(1), 0, 1, null, () => { closeSync(fd); done(); }));
  });
  let released: Promise<void> | undefined;
  return { release: () => released ??= (writeSync(writer, Buffer.alloc(reads.length)), Promise.all(reads).then(() => closeSync(writer))) };
}

/**
 * Marks when a maintenance worker's two output streams have both ended: from
 * then on only Bun's own duplicates of their descriptors can still be open.
 * `launched` runs when the first is created, which is when the launch is done.
 */
function workerOutputs(launched?: () => void) {
  const real = workerPipes.fifoStream;
  let created = 0, ended = 0, end!: () => void;
  const done = new Promise<void>(resolve => { end = resolve; });
  const spy = spyOn(workerPipes, "fifoStream").mockImplementation(fd => {
    if (created++ === 0) launched?.();
    return real(fd).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => { if (++ended === 2) end(); } }));
  });
  return { ended: done, restore: () => spy.mockRestore() };
}

const refusal = (work: () => unknown) => Promise.resolve().then(work).then(() => undefined, (error: unknown) => error as Error);

test("a failed mkfifo refuses as the synchronous form does and releases its directory", async () => {
  const failing = mkfifoShim(() => 'echo "Odysseus: the harbour has no fifo" >&2; exit 1');
  const tmp = ownedTmp();
  try {
    for (const [create, createSync, expected] of [
      [createWorkerPipesSteps, createWorkerPipes, "mkfifo failed: Odysseus: the harbour has no fifo\n"],
      [createWorkerStatusPipeSteps, createWorkerStatusPipe, "Worker status pipe creation failed: Odysseus: the harbour has no fifo\n"],
    ] as const) {
      const awaited = await refusal(() => runWorkerStepsAsync<unknown>(create()));
      expect(awaited?.message, "ASYNC_FIFO_FAILURE_REFUSES").toBe(expected);
      expect((await refusal(createSync))?.message, "SYNC_FIFO_FAILURE_SAME_REFUSAL").toBe(expected);
      expect(tmp.remains(), "FAILED_FIFO_RELEASED").toEqual({ directories: [], descriptors: [] });
    }
  } finally { tmp.restore(); failing.restore(); }
});

test("a partial FIFO setup closes every descriptor it opened, once, and keeps its original error", async () => {
  // Only stdin and stdout exist: the third channel's open fails after four descriptors are held.
  const partial = mkfifoShim(real => `exec "${real}" "$1" "$2" "$3" "$4"`);
  const tmp = ownedTmp();
  try {
    const awaited = await refusal(() => runWorkerStepsAsync(createWorkerPipesSteps())) as NodeJS.ErrnoException | undefined;
    // A second close of a released descriptor would replace this with EBADF.
    expect(awaited?.code, "PARTIAL_FIFO_ORIGINAL_ERROR").toBe("ENOENT");
    expect(tmp.remains(), "PARTIAL_FIFO_RELEASED").toEqual({ directories: [], descriptors: [] });
    expect(((await refusal(createWorkerPipes)) as NodeJS.ErrnoException | undefined)?.code, "SYNC_PARTIAL_FIFO_SAME_ERROR").toBe("ENOENT");
    expect(tmp.remains()).toEqual({ directories: [], descriptors: [] });
  } finally { tmp.restore(); partial.restore(); }
});

const ROOT = resolve(import.meta.dir, "../../..");

function brainFixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/worker-pipes-"));
  const brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  return { root, brain, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("an asynchronous launch whose FIFOs cannot be created starts no worker", async () => {
  const f = brainFixture();
  const startupView = createFixtureWorkerStartupView(f.brain);
  const failing = mkfifoShim(() => "exit 1");
  const tmp = ownedTmp();
  const spawn = spyOn(Bun, "spawn");
  try {
    const refused = await refusal(() => launchAgentWorkerAsync({ brainPath: f.brain, startupView, turnTempBytes: 1024 * 1024,
      command: ["/bin/sh", "-c", "printf ithaca"], env: {} }));
    expect(refused?.message, "LAUNCH_REFUSES_WITHOUT_FIFOS").toContain("mkfifo failed");
    const started = spawn.mock.calls.map(([command]) => basename(String((command as string[])[0])));
    expect(started, "NO_WORKER_WITHOUT_FIFOS").toEqual(["mkfifo"]);
    expect(tmp.remains(), "LAUNCH_FIFOS_RELEASED").toEqual({ directories: [], descriptors: [] });
  } finally { spawn.mockRestore(); tmp.restore(); failing.restore(); startupView.cleanup(); f.cleanup(); }
});

test("an abort accepted while a maintenance launch awaits its FIFOs stops the worker and releases every pipe", async () => {
  const f = brainFixture();
  const startupView = createFixtureWorkerStartupView(f.brain);
  // mkfifo waits for the test: the abort lands while the FIFOs are being created.
  const started = join(f.root, "mkfifo-started"), release = join(f.root, "mkfifo-release");
  const held = mkfifoShim(real => `: > "${started}"; while [ ! -e "${release}" ]; do sleep 0.01; done; exec "${real}" "$@"`);
  const tmp = ownedTmp();
  const controller = new AbortController();
  let run: Promise<Error | undefined> | undefined;
  let pool: ReturnType<typeof holdWorkPool> | undefined;
  const outputs = workerOutputs();
  try {
    const startedAt = performance.now();
    run = refusal(() => runMaintenanceWorker({ brainPath: f.brain, startupView, command: ["/bin/sh", "-c", "exec sleep 30"],
      env: { PATH: "/usr/bin:/bin" }, credentials: false, tempDomain: { statePath: join(f.root, "maintenance-state.db") }, signal: controller.signal }));
    while (!existsSync(started) && performance.now() - startedAt < 10_000) await Bun.sleep(5);
    expect(existsSync(started), "ABORT_LANDS_DURING_MKFIFO").toBe(true);
    controller.abort();
    // The pool is held through the worker's teardown and frees only after it: the launch settles after that.
    const held = pool = holdWorkPool(f.root);
    writeFileSync(release, "");
    void outputs.ended.then(() => Bun.sleep(250)).then(held.release);
    const refused = await run;
    expect(refused, "ABORT_DURING_FIFOS_REJECTS").toBeInstanceOf(DOMException);
    expect(performance.now() - startedAt, "ABORT_DURING_FIFOS_STOPS_WORKER").toBeLessThan(10_000);
    expect(tmp.remains(), "ABORT_DURING_FIFOS_RELEASES_PIPES").toEqual({ directories: [], descriptors: [] });
  } finally {
    // A failed assertion still settles the launch before its fixture goes.
    controller.abort(); writeFileSync(release, ""); await pool?.release(); await run;
    outputs.restore(); tmp.restore(); held.restore(); startupView.cleanup(); f.cleanup();
  }
});

test("an abort that lands while a finished maintenance command's pipes close still refuses its result", async () => {
  const f = brainFixture();
  const startupView = createFixtureWorkerStartupView(f.brain);
  const tmp = ownedTmp();
  const controller = new AbortController();
  let pool: ReturnType<typeof holdWorkPool> | undefined;
  // The pool is held from the end of the launch, before any Bun stream exists.
  const outputs = workerOutputs(() => { pool = holdWorkPool(f.root); });
  let run: Promise<Error | undefined> | undefined;
  try {
    run = refusal(() => runMaintenanceWorker({ brainPath: f.brain, startupView, command: ["/bin/sh", "-c", "printf ithaca"],
      env: { PATH: "/usr/bin:/bin" }, credentials: false, tempDomain: { statePath: join(f.root, "maintenance-state.db") }, signal: controller.signal }));
    // The command has finished; the abort lands while its pipes wait for the pool, which then frees.
    void outputs.ended.then(async () => { await Bun.sleep(50); controller.abort(); await Bun.sleep(200); await pool?.release(); });
    expect(await run, "ABORT_DURING_RELEASE_REFUSES").toBeInstanceOf(DOMException);
    expect(tmp.remains(), "ABORT_DURING_RELEASE_RELEASES_PIPES").toEqual({ directories: [], descriptors: [] });
  } finally {
    controller.abort(); await pool?.release(); await run;
    outputs.restore(); tmp.restore(); startupView.cleanup(); f.cleanup();
  }
});
