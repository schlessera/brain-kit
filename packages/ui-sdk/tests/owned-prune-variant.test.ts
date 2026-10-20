import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownedPruneVariant, ownedPruneDiagnosticSelected } from "../../../scripts/native-proof/owned-prune-variant";
const cron = await Bun.file(resolve(import.meta.dir, "../../ui-server/src/cron/scratch-prune.ts")).text();
const boundary = await Bun.file(resolve(import.meta.dir, "../../ui-server/src/brain/host-boundary.ts")).text();

test("fixed owned-prune variants refuse missing/duplicate anchors and preserve generated syntax", () => {
  const variant = ownedPruneVariant(cron, boundary);
  expect(variant.substitutions).toHaveLength(18);
  for (const [source, text] of [["cron", cron], ["boundary", boundary]] as const) {
    for (const item of variant.substitutions.filter(item => item.source === source)) {
      // Later substitutions can target the earlier generated run slice. Every
      // anchor still comes from the original fixed operation source.
      expect(() => ownedPruneVariant(source === "cron" ? text.replace(item.before, "") : cron,
        source === "boundary" ? text.replace(item.before, "") : boundary), "OWNED_PRUNE_CHANGED_ANCHOR_REFUSES").toThrow();
      expect(() => ownedPruneVariant(source === "cron" ? text.replace(item.before, item.before + "\n" + item.before) : cron,
        source === "boundary" ? text.replace(item.before, item.before + "\n" + item.before) : boundary)).toThrow();
    }
  }
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  expect(() => transpiler.transformSync(variant.cron)).not.toThrow();
  expect(() => transpiler.transformSync(variant.boundary)).not.toThrow();
  expect(variant.cron).toContain('SCRATCH_PRUNE_DEADLINE_MS = 5 * 60 * 1000');
  expect(variant.boundary).toContain('if (execution.purpose !== "brain scratch prune") return;');
  expect(ownedPruneDiagnosticSelected([], false)).toBe(false);
  expect(() => ownedPruneDiagnosticSelected(["--owned-prune-diagnostic"], false)).toThrow();
  expect(ownedPruneDiagnosticSelected(["--owned-prune-diagnostic"], true)).toBe(true);
});

test("real variant tick joins existing work and starts a subsequent pass with the same receiver/signal/output", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-prune-variant-"));
  const source = ownedPruneVariant(cron, boundary).cron.replace('"../governance/events.js"', JSON.stringify(resolve(import.meta.dir, "../../ui-server/src/governance/events.ts")));
  const file = join(root, "scratch-prune.ts"); writeFileSync(file, source);
  const descriptor = Object.getOwnPropertyDescriptor(console, "log")!;
  const records: unknown[] = []; Object.defineProperty(console, "log", { ...descriptor, value: (text: string) => records.push(JSON.parse(text)) });
  let pruner: { tick(): Promise<void>; close(): Promise<void> } | undefined;
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  let calls = 0, pins = 0; const seenSignals: AbortSignal[] = [], warnings: unknown[] = [];
  const brain = { async scratchPrune(options: { signal: AbortSignal; pinsFile: string }) {
    expect(this).toBe(brain); expect(options.pinsFile).toBe("Odysseus pins"); seenSignals.push(options.signal); calls++;
    if (calls === 1) await gate;
    return JSON.stringify({ bytes: 0, pinned: { files: 0, bytes: 0 } });
  } };
  try {
    const { startScratchPrune } = await import(file);
    pruner = startScratchPrune({ brain, pins: { file: "Odysseus pins", async refresh(signal: AbortSignal) { expect(signal.aborted).toBe(false); pins++; } },
      every: () => () => {}, log: { emit(value: unknown) { warnings.push(value); } } });
    const first = pruner!.tick(), second = pruner!.tick(); expect(first).toBe(second);
    release(); await first; await pruner!.tick();
    expect(calls).toBe(2); expect(pins).toBe(2); expect(warnings).toEqual([]); expect(seenSignals[0]).not.toBe(seenSignals[1]);
    const stages = (records as Array<{fixtureOwnedPrune:{stage:string;elapsedMs:number}}>).map(record => record.fixtureOwnedPrune.stage);
    expect(stages.filter(stage => stage === "tick:start-new")).toHaveLength(2);
    expect(stages.filter(stage => stage === "tick:join-existing"), "OWNED_PRUNE_REAL_JOIN_OBSERVED").toHaveLength(2);
    expect(stages.filter(stage => stage === "cli:done")).toHaveLength(2);
    expect(records.every(record => Object.keys(record as object).join() === "fixtureOwnedPrune")).toBe(true);
    // A failed observation cannot replace the successful existing operation.
    Object.defineProperty(console, "log", { ...descriptor, value() { throw Error("Odysseus observation failure"); } });
    await pruner!.tick(); expect(calls).toBe(3); expect(warnings).toEqual([]);
    let entered!: () => void; const enteredCli = new Promise<void>(done => { entered = done; });
    let cancellation: AbortSignal | undefined;
    brain.scratchPrune = async function(options) {
      expect(this).toBe(brain); cancellation = options.signal; entered();
      return await new Promise<string>((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    };
    const pending = pruner!.tick(); await enteredCli;
    await pruner!.close(); await pending;
    expect(cancellation!.aborted).toBe(true);
    expect(warnings).toEqual([{ severityText: "WARN", body: "scratch prune failed; the next pass is in an hour", attributes: { error: "the server is shutting down" } }]);
  } finally {
    release(); try { await pruner?.close(); } finally { Object.defineProperty(console, "log", descriptor); rmSync(root, { recursive: true, force: true }); }
  }
});

test("real original and variant boundary methods preserve owned operation order, result and cleanup error identity", async () => {
  const variant = ownedPruneVariant(cron, boundary).boundary;
  const descriptor = Object.getOwnPropertyDescriptor(console, "log")!, diagnostics: unknown[] = [];
  Object.defineProperty(console, "log", { ...descriptor, value: (line: string) => diagnostics.push(JSON.parse(line)) });
  const failure = Error("Odysseus owned operation refusal");
  async function execute(source: string, fail: boolean, publish = true) {
    const signal = new AbortController().signal, logger = { emit() {} }, launch = { command: ["/bin/true"] };
    const areas = ["scratch"];
    const calls: string[] = [], view = { async cleanup() { calls.push("view-cleanup"); } };
    const output = { view, output: {}, async publish() { calls.push("publish"); }, async cleanup() { calls.push("output-cleanup"); } };
    const dependencies = {
      gated: async (_: unknown, work: (hold: null) => unknown) => { calls.push("gate"); return work(null); }, isolated: () => true,
      credentialed: async (_: unknown, work: () => unknown) => { calls.push("credential"); return work(); },
      prepareInput: async () => { calls.push("view"); return view; }, prepareMaintenanceOutput: async (_: unknown, options: { areas: string[]; signal: AbortSignal; startupView: unknown }) => {
        expect(options.areas, "OWNED_PRUNE_OUTPUT_AREAS_PRESERVED").toBe(areas);
        expect(options.signal).toBe(signal); expect(options.startupView).toBe(view);
        calls.push("output"); return output;
      },
      options: { log: logger }, command: () => launch, prepareMaintenanceGit: async (...args: unknown[]) => {
        expect(args.length, "OWNED_PRUNE_GIT_ARGUMENT_COUNT_PRESERVED").toBe(4);
        expect(args[0], "OWNED_PRUNE_GIT_COMMAND_IDENTITY_PRESERVED").toBe(launch);
        expect(args[1], "OWNED_PRUNE_GIT_OUTPUT_IDENTITY_PRESERVED").toBe(output);
        expect(args[2], "OWNED_PRUNE_GIT_SIGNAL_IDENTITY_PRESERVED").toBe(signal);
        expect(args[3], "OWNED_PRUNE_GIT_LOGGER_IDENTITY_PRESERVED").toBe(logger);
        calls.push("git"); return undefined;
      },
      runMaintenanceWorker: async (options: { signal: AbortSignal; timeoutMs: number; outputBytes: number }, beforeStart: () => void) => {
        expect(options, "OWNED_PRUNE_WORKER_BOUNDS_PRESERVED").toMatchObject({ signal, timeoutMs: 1000, outputBytes: 4096 });
        beforeStart(); calls.push("worker"); if (fail) throw failure; return { stdout: "Odysseus", stderr: "", exitCode: 0, killed: false };
      },
      outputLock: { async withLock(_brain: string, work: () => unknown) { calls.push("output-lock"); return work(); } }, brain: "Odysseus brain",
    };
    const start = source.indexOf("    async run(execution) {"), end = source.indexOf("    async launch(execution) {", start);
    const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync("const operation = {" + source.slice(start, end) + "}; return operation.run;");
    const operation = new Function(...Object.keys(dependencies), javascript)(...Object.values(dependencies));
    try { return { result: await operation({ purpose: "brain scratch prune", signal, outputAreas: areas, outputBytes: 4096, timeoutMs: 1000, publish,
      assertAuthorized() { calls.push("authorize"); }, onExecute() { calls.push("on-execute"); } }), calls }; }
    catch (error) { return { error, calls }; }
  }
  try {
    const original = await execute(boundary, false), observed = await execute(variant, false);
    expect(observed, "OWNED_PRUNE_AUTHORITY_AND_EXECUTION_PRESERVED").toEqual(original);
    expect(observed.calls).toEqual(["authorize", "gate", "credential", "output-lock", "authorize", "view", "output", "git", "authorize", "authorize", "on-execute", "worker", "authorize", "publish", "output-cleanup", "view-cleanup"]);
    const failedOriginal = await execute(boundary, true), failedObserved = await execute(variant, true);
    expect(failedObserved.calls).toEqual(failedOriginal.calls); expect(failedObserved.error).toBe(failure); expect(failedOriginal.error).toBe(failure);
    expect(failedObserved.calls.slice(-2)).toEqual(["output-cleanup", "view-cleanup"]);
    const unpublishedOriginal = await execute(boundary, false, false), unpublishedObserved = await execute(variant, false, false);
    expect(unpublishedObserved, "OWNED_PRUNE_DISCARD_PRESERVED").toEqual(unpublishedOriginal);
    expect(unpublishedObserved.calls).not.toContain("publish");
    expect(diagnostics.every(record => Object.keys(record as object).join() === "fixtureOwnedPruneBoundary")).toBe(true);
  } finally { Object.defineProperty(console, "log", descriptor); }
});
