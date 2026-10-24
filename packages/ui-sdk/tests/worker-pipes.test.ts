/**
 * #1648: a worker's output pipes are read without holding a thread. Node's fs
 * read streams park a thread-pool thread on every pending FIFO read, and the
 * pool is sized from the CPU count: on a four-CPU CI runner two idle workers
 * held all of it, and every other asynchronous file operation in the server,
 * a maintenance worker's own included, waited for a worker to speak.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { availableParallelism } from "node:os";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
  try {
    const startedAt = performance.now();
    run = refusal(() => runMaintenanceWorker({ brainPath: f.brain, startupView, command: ["/bin/sh", "-c", "exec sleep 30"],
      env: { PATH: "/usr/bin:/bin" }, credentials: false, tempDomain: { statePath: join(f.root, "maintenance-state.db") }, signal: controller.signal }));
    while (!existsSync(started) && performance.now() - startedAt < 10_000) await Bun.sleep(5);
    expect(existsSync(started), "ABORT_LANDS_DURING_MKFIFO").toBe(true);
    controller.abort();
    writeFileSync(release, "");
    const refused = await run;
    expect(refused, "ABORT_DURING_FIFOS_REJECTS").toBeInstanceOf(DOMException);
    expect(performance.now() - startedAt, "ABORT_DURING_FIFOS_STOPS_WORKER").toBeLessThan(10_000);
    expect(tmp.remains(), "ABORT_DURING_FIFOS_RELEASES_PIPES").toEqual({ directories: [], descriptors: [] });
  } finally {
    // A failed assertion still settles the launch before its fixture goes.
    controller.abort(); writeFileSync(release, ""); await run;
    tmp.restore(); held.restore(); startupView.cleanup(); f.cleanup();
  }
});
