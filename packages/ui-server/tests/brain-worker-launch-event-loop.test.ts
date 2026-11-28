/**
 * The masked brain CLI run and the turn data tree run await the launcher
 * (#4862): the blocking form would stall the server's event loop while a
 * loaded host sets up bubblewrap. Once the launch is awaited, an abort can
 * land before the abort listener exists, so each checks the signal after the
 * launch resolves.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { closeSync, constants, createWriteStream, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { runMaskedBrainCli } from "../src/brain/private-index.js";
import { createTurnDataTree } from "../src/brain/turn-data-tree.js";

const native = process.platform === "linux" && Boolean(Bun.which("bwrap"));
type Launched = Awaited<ReturnType<typeof worker.launchAgentWorkerAsync>>;
type Launch = Parameters<typeof worker.launchAgentWorkerAsync>[0];

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-launch-loop-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"), index = join(root, "index");
  mkdirSync(join(brain, "notes"), { recursive: true });
  mkdirSync(join(brain, ".brain-index")); mkdirSync(index);
  writeFileSync(join(brain, "notes/harbor.md"), "Odysseus at the harbour.\n");
  const startupView = createFixtureWorkerStartupView(brain);
  cleanup.push(() => startupView.cleanup());
  return { brain, brainPath: brain, startupView, index, folders: [], maskPaths: [], timeoutMs: 60_000, label: "masked CLI" };
}

/**
 * Both launcher forms observed. The awaitable one runs the real launcher with
 * only the worker program substituted, after `before` resolves; the blocking
 * one is counted and passes through.
 */
function observe(options: { script: string; before?: (input: Launch) => Promise<void>; killFailsOnce?: boolean; brokenStdin?: boolean }) {
  const ticks = { count: 0, timer: setInterval(() => { ticks.count++; }, 1) };
  const seen = { awaitable: 0, blocking: 0, ticksWhilePending: 0, children: [] as Launched[], signals: [] as string[], retained: 0, cleaned: 0 };
  const realAsync = worker.launchAgentWorkerAsync, realSync = worker.launchAgentWorker, realRetain = worker.retainWorkerStartupView;
  const awaitable = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async (input) => {
    seen.awaitable++;
    const before = ticks.count;
    try {
      await options.before?.(input);
      const child = await realAsync({ ...input, command: ["/bin/sh", "-c", options.script] });
      seen.children.push(child);
      // The signals the run sends this worker before it exits.
      const kill = child.kill.bind(child);
      let exited = false; void child.exited.finally(() => { exited = true; });
      let failing = options.killFailsOnce === true;
      child.kill = (signal) => {
        if (!exited) seen.signals.push(signal ?? "SIGTERM");
        // As the identity broker's signal request can fail.
        if (failing) { failing = false; throw new Error("Odysseus: the signal request failed"); }
        kill(signal);
      };
      const stdin = child.stdin;
      cleanup.push(async () => { child.kill("SIGKILL"); stdin.end(); await child.exited; await child.released(); });
      // As a worker's pipe is once the worker is gone: every write fails with EPIPE.
      if (options.brokenStdin) child.stdin = brokenPipe();
      return child;
    } finally { seen.ticksWhilePending += ticks.count - before; }
  });
  const blocking = spyOn(worker, "launchAgentWorker").mockImplementation((input) => { seen.blocking++; return realSync(input); });
  // The retained startup view each run takes, observed for its cleanup.
  const retain = spyOn(worker, "retainWorkerStartupView").mockImplementation((view) => {
    seen.retained++;
    const retained = realRetain(view), release = retained.cleanup;
    return { ...retained, cleanup: () => { seen.cleaned++; return release(); } };
  });
  cleanup.push(() => { clearInterval(ticks.timer); awaitable.mockRestore(); blocking.mockRestore(); retain.mockRestore(); });
  return seen;
}

/** A write stream on a FIFO whose only reader is closed, as a killed worker's stdin is. */
function brokenPipe() {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-broken-pipe-")), path = join(dir, "stdin");
  try {
    expect(Bun.spawnSync([Bun.which("mkfifo")!, "-m", "600", path]).exitCode).toBe(0);
    const hold = openSync(path, constants.O_RDWR), reader = openSync(path, constants.O_RDONLY), writer = openSync(path, constants.O_WRONLY);
    closeSync(hold); closeSync(reader);
    return createWriteStream("", { fd: writer, autoClose: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function treeFor(f: ReturnType<typeof fixture>) {
  const tree = await createTurnDataTree({ brainPath: f.brain, view: f.startupView, maskPaths: [], mount: true });
  cleanup.push(() => tree.close());
  return tree;
}

const outcome = <T>(work: Promise<T>) => work.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));

test("a masked CLI run awaits the launcher once and never calls the blocking form", async () => {
  const f = fixture();
  const seen = observe({ script: "printf Ithaca" });
  expect(await runMaskedBrainCli({ ...f, signal: new AbortController().signal, command: ["/bin/sh"] })).toEqual({ ok: true, stdout: "Ithaca" });
  expect({ awaitable: seen.awaitable, blocking: seen.blocking }).toEqual({ awaitable: 1, blocking: 0 });
});

test("a turn data tree run awaits the launcher once and never calls the blocking form", async () => {
  const f = fixture();
  const tree = await treeFor(f);
  const seen = observe({ script: 'IFS= read -r request; printf \'{"ok":true,"plan":"Ithaca"}\\n\'' });
  expect(await tree.planAdd({ title: "Ithaca" }, new AbortController().signal)).toBe("Ithaca");
  expect({ awaitable: seen.awaitable, blocking: seen.blocking }).toEqual({ awaitable: 1, blocking: 0 });
});

for (const path of ["masked CLI", "turn tree"] as const) {
  test.skipIf(!native)(`${path}: the event loop turns while the real launch is pending`, async () => {
    const f = fixture();
    const tree = path === "turn tree" ? await treeFor(f) : undefined;
    const seen = observe({ script: path === "masked CLI" ? "printf Ithaca" : 'IFS= read -r request; printf \'{"ok":true,"plan":"Ithaca"}\\n\'' });
    if (tree) await tree.planAdd({ title: "Ithaca" }, new AbortController().signal);
    else await runMaskedBrainCli({ ...f, signal: new AbortController().signal, command: ["/bin/sh"] });
    expect(seen.awaitable).toBe(1);
    // A count of event-loop turns, not a duration: a 1 ms interval cannot fire during synchronous work.
    expect(seen.ticksWhilePending).toBeGreaterThanOrEqual(1);
  });

  test(`${path}: an abort while the launch is pending kills the worker once it launches`, async () => {
    const f = fixture(), controller = new AbortController();
    const tree = path === "turn tree" ? await treeFor(f) : undefined;
    // The program ends by itself after a few seconds, well inside the run's timeout:
    // a run that missed the abort sends no signal before the worker exits.
    const seen = observe({ script: path === "masked CLI" ? "printf Ithaca; exec sleep 3" : "IFS= read -r request; exec sleep 3",
      before: async () => { controller.abort(); } });
    const result = await outcome(tree ? tree.planAdd({ title: "Ithaca" }, controller.signal)
      : runMaskedBrainCli({ ...f, signal: controller.signal, command: ["/bin/sh"] }));
    expect(seen.children).toHaveLength(1);
    expect(seen.signals, "SIGKILL is sent as soon as the launch resolves").toEqual(["SIGKILL"]);
    expect(result.error, "the run reports the abort").toBeInstanceOf(DOMException);
    expect({ retained: seen.retained, cleaned: seen.cleaned }).toEqual({ retained: 1, cleaned: 1 });
  });

  test(`${path}: a failed kill after an abort during launch still cleans up and reports the abort`, async () => {
    const f = fixture(), controller = new AbortController();
    const tree = path === "turn tree" ? await treeFor(f) : undefined;
    const seen = observe({ script: path === "masked CLI" ? "printf Ithaca; exec sleep 3" : "IFS= read -r request; exec sleep 3",
      before: async () => { controller.abort(); }, killFailsOnce: true });
    const result = await outcome(tree ? tree.planAdd({ title: "Ithaca" }, controller.signal)
      : runMaskedBrainCli({ ...f, signal: controller.signal, command: ["/bin/sh"] }));
    expect(result.error, "the abort, not the failed signal request").toBeInstanceOf(DOMException);
    // The run's own cleanup ran: the worker was signalled again and its view released.
    expect(seen.signals.length).toBeGreaterThanOrEqual(2);
    expect({ retained: seen.retained, cleaned: seen.cleaned }).toEqual({ retained: 1, cleaned: 1 });
  });

  test(`${path}: a rejected launch cleans up the startup view and reports as before`, async () => {
    const f = fixture();
    const tree = path === "turn tree" ? await treeFor(f) : undefined;
    const seen = observe({ script: "printf Ithaca", before: async () => { throw new Error("Odysseus: the sandbox could not be built"); } });
    const result = await outcome(tree ? tree.planAdd({ title: "Ithaca" }, new AbortController().signal)
      : runMaskedBrainCli({ ...f, signal: new AbortController().signal, command: ["/bin/sh"] }));
    if (tree) expect(result.error instanceof Error && result.error.message).toBe("Odysseus: the sandbox could not be built");
    else expect(result.value).toEqual({ ok: false, detail: "Odysseus: the sandbox could not be built" });
    expect({ retained: seen.retained, cleaned: seen.cleaned }).toEqual({ retained: 1, cleaned: 1 });
  });
}

// The request goes to a worker whose pipe may already be closed. Its write
// error must reach no one but the run: unheard, it is an uncaught exception
// that ends the host process, and the test runner fails the test on it (#5050).
test("turn tree: an abort during launch with the worker's pipe already closed reports the abort, not EPIPE", async () => {
  const f = fixture(), controller = new AbortController();
  const tree = await treeFor(f);
  observe({ script: "IFS= read -r request; exec sleep 3", before: async () => { controller.abort(); }, brokenStdin: true });
  const result = await outcome(tree.planAdd({ title: "Ithaca" }, controller.signal));
  // The stream reports its error on a later tick; give it one inside this test.
  await new Promise(resolve => setImmediate(resolve));
  expect(result.error, "the run reports the abort").toBeInstanceOf(DOMException);
});

test("turn tree: a worker that is gone before its request is written fails the run, not the process", async () => {
  const f = fixture();
  const tree = await treeFor(f);
  observe({ script: "exit 3", brokenStdin: true });
  const result = await outcome(tree.planAdd({ title: "Ithaca" }, new AbortController().signal));
  // The stream reports its error on a later tick; give it one inside this test.
  await new Promise(resolve => setImmediate(resolve));
  expect(result.error instanceof Error && result.error.message).toMatch(/gave no answer \(exit 3\)/);
});
