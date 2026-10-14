import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox } from "../src/server/worker-launcher.js";
import { prepareFixtureWorkerOutput as prepareWorkerOutput } from "./helpers/worker-startup-view-fixture.js";
import { launchMaintenanceWorker, runMaintenanceWorkerSync } from "../src/server/maintenance-worker.js";
import { createFixtureWorkerStartupView as createWorkerStartupView } from "./helpers/worker-startup-view-fixture.js";
import { createStateLedger, processStateLedger } from "../src/server/worker-state-budget.js";
import { hostOutputStagingLimits, resolveOutputStagingLimits, outputStagingLimit } from "../src/server/worker-state-limits.js";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
for (const profile of ["strict", "maintenance"] as const) test(`${profile} refuses 8 MiB of staging past a 1 MiB allowance`, async () => {
  const old = process.env.BRAIN_UI_OUTPUT_STAGING_BYTES;
  process.env.BRAIN_UI_OUTPUT_STAGING_BYTES = String(1024 ** 2);
  cleanup.push(() => { if (old === undefined) delete process.env.BRAIN_UI_OUTPUT_STAGING_BYTES; else process.env.BRAIN_UI_OUTPUT_STAGING_BYTES = old; });
  const brain = mkdtempSync("/tmp/odysseus-output-budget-");
  cleanup.push(() => rmSync(brain, { recursive: true, force: true }));
  mkdirSync(join(brain, "workspaces"));
  const outputs = profile === "maintenance" ? prepareWorkerOutput(brain) : undefined;
  if (outputs) cleanup.push(outputs.cleanup);
  const path = profile === "strict" ? "/tmp/brain-worker-areas/workspaces/proof.bin" : "/tmp/brain-maintenance-output/workspaces/proof.bin";
  const command = [process.execPath, "--config=/dev/null", "--no-env-file", "-e", `const fs=require("node:fs");
    try { fs.writeFileSync(${JSON.stringify(path)}, Buffer.alloc(8 * 1024 ** 2)); console.log("UNBOUNDED"); }
    catch (error) { console.log(error.code); }
    console.log(fs.statfsSync(${JSON.stringify(path.replace("/proof.bin", ""))}).blocks * fs.statfsSync(${JSON.stringify(path.replace("/proof.bin", ""))}).bsize);`];
  const worker = launchAgentWorker({ brainPath: brain, env: {}, command,
    ...(outputs ? { startupView: outputs.view, maintenance: { network: false, credentials: false, readPaths: [process.execPath], output: outputs.output } }
      : { startupView: createWorkerStartupView(brain), sandbox: prepareWorkerSandbox(brain, { profile: "strict", areas: ["workspaces"], readPaths: [process.execPath] }), turnTempBytes: 1024 ** 2 }) });
  cleanup.push(() => worker.kill("SIGKILL"));
  let stdout = "", stderr = "";
  worker.stdout.on("data", data => { stdout += String(data); }); worker.stderr.on("data", data => { stderr += String(data); });
  expect(await worker.exited, stderr).toBe(0);
  worker.turnTemp?.close();
  expect(stdout, "OUTPUT_STAGING_OVERFLOW_ENOSPC").toBe("ENOSPC\n1048576\n");
});


test("output staging validates defaults, explicit budgets and the disclosed limit", () => {
  expect(resolveOutputStagingLimits({ maxConcurrentSessions: 4 })).toEqual({ allowanceBytes: 256 * 1024 ** 2, budgetBytes: 1024 ** 3 });
  expect(hostOutputStagingLimits({ BRAIN_UI_OUTPUT_STAGING_BYTES: "1048576", BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES: "2097152" })).toEqual({ allowanceBytes: 1024 ** 2, budgetBytes: 2 * 1024 ** 2 });
  for (const raw of ["1", "0", "-4096", "1MiB", "1e6", "4096.5"]) expect(() => hostOutputStagingLimits({ BRAIN_UI_OUTPUT_STAGING_BYTES: raw })).toThrow("BRAIN_UI_OUTPUT_STAGING_BYTES");
  expect(() => hostOutputStagingLimits({ BRAIN_UI_OUTPUT_STAGING_BYTES: "8192", BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES: "4096" })).toThrow("smaller than one worker");
  expect(outputStagingLimit({ allowanceBytes: 1024 ** 2, budgetBytes: 1024 ** 2 })).toMatchObject({ value: "1 MiB" });
  expect(outputStagingLimit().onHit).toContain("ENOSPC");
});

test("the shared ledger reserves all three allowances or none and permits Retry", () => {
  const ledger = createStateLedger();
  const one = { allowanceBytes: 1024 ** 2, budgetBytes: 1024 ** 2 };
  const held = ledger.reserve(undefined, undefined, one);
  expect(() => ledger.reserve(one, one, one), "OUTPUT_STAGING_ADMISSION").toThrow("Retry");
  expect([ledger.held, ledger.turnTempHeld, ledger.outputStagingHeld, ledger.live]).toEqual([0, 0, 1024 ** 2, 1]);
  held.release(); held.release();
  const retry = ledger.reserve(one, one, one);
  expect([retry.bytes, retry.turnTempBytes, retry.outputStagingBytes]).toEqual([1024 ** 2, 1024 ** 2, 1024 ** 2]);
  retry.release(); expect([ledger.held, ledger.turnTempHeld, ledger.outputStagingHeld, ledger.live]).toEqual([0, 0, 0, 0]);
});

test("real staging admission excludes immutable input and refuses competing writable output until cleanup", () => {
  const old = process.env.BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES;
  process.env.BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES = String(256 * 1024 ** 2);
  cleanup.push(() => { if (old === undefined) delete process.env.BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES; else process.env.BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES = old; });
  const brain = mkdtempSync("/tmp/odysseus-staging-admission-"); cleanup.push(() => rmSync(brain, { recursive: true, force: true }));
  const ledger = processStateLedger(), before = ledger.outputStagingHeld;
  const view = createWorkerStartupView(brain); cleanup.push(view.cleanup);
  expect(ledger.outputStagingHeld, "IMMUTABLE_INPUT_DOES_NOT_RESERVE_STAGED_WRITES").toBe(before);
  const outputs = prepareWorkerOutput(brain, { startupView: view }); cleanup.push(outputs.cleanup);
  expect(ledger.outputStagingHeld).toBe(before + 256 * 1024 ** 2);
  let competing: ReturnType<typeof prepareWorkerOutput> | undefined;
  try { competing = prepareWorkerOutput(brain, { startupView: view }); throw new Error("admitted competing output"); }
  catch (error) { expect(error).toMatchObject({ errorClass: "worker_state_busy" }); expect((error as Error).message).toContain("Retry"); }
  finally { competing?.cleanup(); }
  outputs.cleanup(); outputs.cleanup(); expect(ledger.outputStagingHeld).toBe(before);
  const retry = prepareWorkerOutput(brain, { startupView: view }); retry.cleanup(); expect(ledger.outputStagingHeld).toBe(before);
});

test("unchanged starting bytes are exempt while output writes remain bounded and cleanup releases admission", () => {
  const old = process.env.BRAIN_UI_OUTPUT_STAGING_BYTES;
  process.env.BRAIN_UI_OUTPUT_STAGING_BYTES = String(1024 ** 2);
  cleanup.push(() => { if (old === undefined) delete process.env.BRAIN_UI_OUTPUT_STAGING_BYTES; else process.env.BRAIN_UI_OUTPUT_STAGING_BYTES = old; });
  const brain = mkdtempSync("/tmp/odysseus-staging-start-"); cleanup.push(() => rmSync(brain, { recursive: true, force: true }));
  writeFileSync(join(brain, "Odysseus.bin"), Buffer.alloc(600 * 1024, 1));
  const ledger = processStateLedger(), before = ledger.outputStagingHeld;
  const outputs = prepareWorkerOutput(brain); cleanup.push(outputs.cleanup);
  try {
    expect(readFileSync(join(outputs.output.source, "Odysseus.bin"))).toEqual(Buffer.alloc(600 * 1024, 1));
    expect(ledger.outputStagingHeld).toBe(before + 1024 ** 2);
    expect(() => writeFileSync(join(outputs.output.source, "overflow.bin"), Buffer.alloc(2 * 1024 ** 2)), "ONLY_WRITABLE_BYTES_ARE_BOUNDED").toThrow("ENOSPC");
    expect(readFileSync(join(brain, "Odysseus.bin"))).toEqual(Buffer.alloc(600 * 1024, 1));
  } finally { outputs.cleanup(); }
  expect(ledger.outputStagingHeld).toBe(before);
  writeFileSync(join(brain, "Odysseus.bin"), "before");
  const retry = prepareWorkerOutput(brain);
  try { writeFileSync(join(retry.output.source, "Odysseus.bin"), "after"); retry.publish(); expect(readFileSync(join(brain, "Odysseus.bin"), "utf8")).toBe("after"); }
  finally { retry.cleanup(); }
  expect(ledger.outputStagingHeld).toBe(before);
});


for (const mode of ["streaming", "sync"] as const) test(`${mode} maintenance bootstrap refusal releases staging`, () => {
  const brain = mkdtempSync("/tmp/odysseus-staging-refusal-"); cleanup.push(() => rmSync(brain, { recursive: true, force: true }));
  const ledger = processStateLedger(), before = ledger.outputStagingHeld;
  const outputs = prepareWorkerOutput(brain); cleanup.push(outputs.cleanup);
  const original = Bun.which;
  const which = spyOn(Bun, "which").mockImplementation((name, options) => name === "nsenter" ? null : original(name, options));
  try {
    const input = { brainPath: brain, startupView: outputs.view, output: outputs.output, command: ["/bin/true"], env: {}, credentials: false, timeoutMs: 1000 };
    expect(() => mode === "streaming" ? launchMaintenanceWorker(input) : runMaintenanceWorkerSync(input)).toThrow("nsenter");
    outputs.cleanup();
    expect(ledger.outputStagingHeld, "BOOTSTRAP_REFUSAL_RELEASES_OWNED_STAGING").toBe(before);
  } finally { which.mockRestore(); outputs.cleanup(); }
});
