/** Masked CLI and turn-tree maintenance settlement includes Bun's delayed FIFO closes (#2879). */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { holdWorkPool, ownedWorkerFifos } from "../../ui-sdk/tests/helpers/work-pool.js";
import { runMaskedBrainCli } from "../src/brain/private-index.js";
import { createTurnDataTree } from "../src/brain/turn-data-tree.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-masked-release-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"), index = join(root, "index");
  mkdirSync(join(brain, "notes"), { recursive: true });
  mkdirSync(join(brain, ".brain-index")); mkdirSync(index);
  writeFileSync(join(brain, "notes/harbor.md"), "Odysseus at the harbour.\n");
  const startupView = createFixtureWorkerStartupView(brain);
  cleanup.push(() => startupView.cleanup());
  return { brain, brainPath: brain, startupView, index, folders: [], maskPaths: [], timeoutMs: 10_000, label: "masked CLI" };
}

type Launched = ReturnType<typeof worker.launchAgentWorker>;
type Withheld = { promise: Promise<void>; called(): void };

/** The actual launcher and FIFOs; only the credential-free worker program is substituted. */
function observeLaunch(options: { script: string; pool?: true | "input"; withheld?: Withheld; launched?: (child: Launched) => void }) {
  const fifos = ownedWorkerFifos();
  cleanup.push(fifos.restore);
  let pool: ReturnType<typeof holdWorkPool> | undefined;
  const real = worker.launchAgentWorker;
  const launch = spyOn(worker, "launchAgentWorker").mockImplementation(input => {
    const child = real({ ...input, command: ["/bin/sh", "-c", options.script] });
    cleanup.push(async () => {
      child.kill("SIGKILL");
      child.stdin.end(); child.stdout.destroy(); child.stderr.destroy();
      await pool?.release(); await child.exited; await child.released();
    });
    if (options.withheld) {
      const released = child.released;
      child.released = () => { options.withheld!.called(); return options.withheld!.promise.then(released); };
    }
    const hold = () => {
      const held = pool = holdWorkPool(fifos.dir);
      const ended = (stream: NodeJS.ReadableStream) => new Promise(resolve => stream.once("end", resolve));
      // Hold Bun's pool throughout teardown, then free it after both real outputs reach EOF.
      void Promise.all([ended(child.stdout), ended(child.stderr)]).then(() => Bun.sleep(250)).then(held.release);
    };
    // Input writes and close use the pool too: deliver the tree's whole request and EOF first.
    if (options.pool === "input") child.stdin.once("close", hold);
    else if (options.pool) hold();
    options.launched?.(child);
    return child;
  });
  cleanup.push(() => launch.mockRestore());
  return { held: () => Boolean(pool), open: fifos.held };
}

const outcome = <T>(work: Promise<T>) => work.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));

for (const mode of ["success", "failure", "oversized", "timeout", "abort"] as const) {
  test(`a masked CLI ${mode} settles after every worker stdio descriptor closes`, async () => {
    const f = fixture(), controller = new AbortController();
    const blocked = mode === "timeout" || mode === "abort";
    const seen = observeLaunch({ pool: true,
      script: blocked ? "printf Ithaca; exec sleep 30" : `printf Ithaca; printf Penelope >&2; exit ${mode === "failure" ? 3 : 0}`,
      ...(mode === "abort" ? { launched: (child: Launched) => { child.stdout.once("data", () => controller.abort()); } } : {}) });
    const result = await outcome(runMaskedBrainCli({ ...f, signal: controller.signal, command: [],
      ...(mode === "timeout" ? { timeoutMs: 100 } : {}), ...(mode === "oversized" ? { outputBytes: 2 } : {}) }));
    const open = seen.open();
    expect(seen.held(), "POOL_HELD_THROUGH_MASKED_CLI_TEARDOWN").toBe(true);
    if (mode === "abort") expect(result.error, "MASKED_CLI_ABORT_REFUSES").toBeInstanceOf(DOMException);
    else {
      expect(result.error).toBeUndefined();
      expect(result.value, "MASKED_CLI_OUTCOME_PRESERVED").toEqual(mode === "success" ? { ok: true, stdout: "Ithaca" }
        : { ok: false, detail: mode === "failure" ? "masked CLI exited 3: Penelope"
          : mode === "oversized" ? "masked CLI wrote more than 2 bytes" : "masked CLI did not finish within 0.1 s" });
    }
    expect(open, "MASKED_CLI_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
  });
}

test("a masked CLI output read failure stops its worker and releases its stdio", async () => {
  const f = fixture();
  let child: Launched | undefined;
  const seen = observeLaunch({ script: "printf Ithaca; exec sleep 30", launched: launched => {
    child = launched;
    child.stdout.once("data", () => child!.stdout.destroy(new Error("Odysseus stopped the read")));
  } });
  const work = outcome(runMaskedBrainCli({ ...f, signal: new AbortController().signal, command: [] }));
  try {
    const result = await Promise.race([work, Bun.sleep(10_000).then(() => undefined)]);
    expect(result, "OUTPUT_READ_FAILURE_STOPS_WORKER").toBeDefined();
    expect(result!.error instanceof Error && result!.error.message, "OUTPUT_READ_FAILURE_PRESERVED").toBe("Odysseus stopped the read");
    expect(seen.open(), "OUTPUT_READ_FAILURE_RELEASES_STDIO").toEqual([]);
  } finally { child?.kill("SIGKILL"); await work; }
});

for (const mode of ["success", "failure"] as const) {
  test(`turn-tree maintenance ${mode} settles after every worker stdio descriptor closes`, async () => {
    const f = fixture();
    const answer = mode === "success" ? { ok: true, plan: "Ithaca" } : { ok: false, error: "Penelope" };
    const seen = observeLaunch({ pool: "input", script: `IFS= read -r request; sleep 0.3; printf '%s\\n' '${JSON.stringify(answer)}'` });
    const tree = createTurnDataTree({ brainPath: f.brain, view: f.startupView, maskPaths: [], mount: true });
    cleanup.push(() => tree.close());
    const result = await outcome(tree.planAdd({ title: "Ithaca" }, new AbortController().signal));
    const open = seen.open();
    expect(seen.held(), "POOL_HELD_THROUGH_TREE_TEARDOWN").toBe(true);
    if (mode === "success") expect(result.value, "TREE_WORKER_ANSWER_PRESERVED").toBe("Ithaca");
    else expect(result.error instanceof Error && result.error.message, "TREE_WORKER_REFUSAL_PRESERVED").toBe("Penelope");
    expect(open, "TREE_WORKER_SETTLES_AFTER_STDIO_RELEASE").toEqual([]);
  });
}

for (const path of ["masked CLI", "turn tree"] as const) for (const abort of [false, true]) {
  test(`${path} reports exit before release and ${abort ? "refuses an abort during" : "waits for"} release`, async () => {
    const f = fixture(), controller = new AbortController();
    const release = Promise.withResolvers<void>(), calling = Promise.withResolvers<void>();
    cleanup.push(() => release.resolve());
    let child: Launched | undefined, settled = false;
    observeLaunch({ script: path === "masked CLI" ? "printf Ithaca" : 'IFS= read -r request; printf \'{"ok":true,"plan":"Ithaca"}\\n\'',
      withheld: { promise: release.promise, called: calling.resolve }, launched: launched => { child = launched; } });
    const tree = path === "turn tree" ? createTurnDataTree({ brainPath: f.brain, view: f.startupView, maskPaths: [], mount: true }) : undefined;
    if (tree) cleanup.push(() => tree.close());
    const work = outcome(tree ? tree.planAdd({}, controller.signal)
      : runMaskedBrainCli({ ...f, signal: controller.signal, command: [] })).then(result => { settled = true; return result; });
    try {
      expect(await Promise.race([calling.promise.then(() => true), work.then(() => false), Bun.sleep(10_000).then(() => false)]), "SETTLEMENT_REACHES_RELEASE").toBe(true);
      expect(await Promise.race([child!.exited, Bun.sleep(10_000).then(() => "no exit")]), "EXIT_REPORTED_WHILE_RELEASE_PENDING").toBe(0);
      await Bun.sleep(25);
      expect(settled, "SETTLEMENT_WAITS_FOR_RELEASE").toBe(false);
      if (abort) controller.abort();
      release.resolve();
      const result = await work;
      if (abort) expect(result.error, "ABORT_DURING_RELEASE_REFUSES").toBeInstanceOf(DOMException);
      else { expect(result.error).toBeUndefined(); expect(result.value).toEqual(tree ? "Ithaca" : { ok: true, stdout: "Ithaca" }); }
    } finally { release.resolve(); await work; }
  });
}
