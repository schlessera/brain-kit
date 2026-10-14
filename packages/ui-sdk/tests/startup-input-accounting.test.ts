import { expect, test } from "bun:test";
import { mkdtempSync, openSync, writeSync, closeSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareFixtureWorkerOutput as prepareWorkerOutput } from "./helpers/worker-startup-view-fixture.js";
import { runMaintenanceWorker } from "../src/server/maintenance-worker.js";
import { text } from "node:stream/consumers";
import { createOutputStagingStorage, launchAgentWorker, prepareWorkerSandbox } from "../src/server/worker-launcher.js";
import { createFixtureWorkerStartupView as createWorkerStartupView } from "./helpers/worker-startup-view-fixture.js";

test("complete immutable inputs larger than output staging are not staged writes", async () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-large-input-"));
  let view: ReturnType<typeof createWorkerStartupView> | undefined;
  try {
    mkdirSync(join(brain, "node_modules"));
    const fd = openSync(join(brain, "node_modules", "odysseus-input.bin"), "wx");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    try { for (let i = 0; i < 257; i++) writeSync(fd, chunk); } finally { closeSync(fd); }
    mkdirSync(join(brain, ".brain", "scratch"), { recursive: true });
    view = createWorkerStartupView(brain);
    expect(view.root).toBeDefined();
    const worker = launchAgentWorker({ brainPath: brain, startupView: view, sandbox: prepareWorkerSandbox(brain, { profile: "strict", areas: ["scratch"], maintenance: { startupView: view, tempDomain: { statePath: join(view.storage.root, "maintenance-state.db") } } }),
      env: {}, command: ["/bin/sh", "-c", '/usr/bin/head -c1 node_modules/odysseus-input.bin; printf "Penelope strict output" > /tmp/brain-worker-areas/scratch/retained.txt'] });
    const streams = Promise.all([text(worker.stdout), text(worker.stderr)]);
    try {
      expect(await worker.exited, (await streams)[1]).toBe(0);
      expect((await streams)[0]).toBe("a");
      expect(readFileSync(join(brain, ".brain/scratch/retained.txt"), "utf8"), "STRICT_LARGE_INPUT_RETAINS_ALLOWED_OUTPUT").toBe("Penelope strict output");
    } finally { worker.kill("SIGKILL"); }
  } finally { view?.cleanup(); rmSync(brain, { recursive: true, force: true }); }
});


test("a real maintenance output over a large immutable baseline publishes and retains its write bound after deletion", async () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-large-output-"));
  let outputs: ReturnType<typeof prepareWorkerOutput> | undefined;
  try {
    const fd = openSync(join(brain, "odysseus-baseline.bin"), "wx");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    try { for (let i = 0; i < 257; i++) writeSync(fd, chunk); } finally { closeSync(fd); }
    writeFileSync(join(brain, "helper.txt"), "Odysseus before launch");
    outputs = prepareWorkerOutput(brain);
    const result = await runMaintenanceWorker({ brainPath: brain, tempDomain: { statePath: join(outputs.view.storage.root, "maintenance-state.db") }, startupView: outputs.view, output: outputs.output,
      credentials: false, env: {}, command: ["/bin/sh", "-c", '/usr/bin/head -c1 odysseus-baseline.bin; /usr/bin/cat helper.txt; printf "Penelope retained" > "$BRAIN_ROOT/retained.txt"'] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toBe("aOdysseus before launch");
    expect(existsSync(join(brain, "retained.txt")), "PRIVATE_UNTIL_VALIDATED_PUBLICATION").toBe(false);
    await outputs.publish();
    expect(readFileSync(join(brain, "retained.txt"), "utf8")).toBe("Penelope retained");
    outputs.cleanup(); outputs = prepareWorkerOutput(brain);
    // Removing a large lower-only input creates a bounded whiteout, not free
    // write capacity. Its original bytes remain canonical until publication.
    const overflow = await runMaintenanceWorker({ brainPath: brain, tempDomain: { statePath: join(outputs.view.storage.root, "maintenance-state.db") }, startupView: outputs.view, output: outputs.output,
      credentials: false, env: {}, command: ["/bin/sh", "-c", '/usr/bin/rm "$BRAIN_ROOT/odysseus-baseline.bin" && /usr/bin/dd if=/dev/zero of="$BRAIN_ROOT/overflow.bin" bs=1048576 count=257'] });
    expect(overflow.exitCode, "DELETING_BASELINE_CANNOT_EXPAND_WRITABLE_ALLOWANCE").not.toBe(0);
    expect(overflow.stderr).toContain("No space left on device");
    expect(existsSync(join(brain, "odysseus-baseline.bin"))).toBe(true);
    expect(existsSync(join(brain, "overflow.bin"))).toBe(false);
  } finally { outputs?.cleanup(); rmSync(brain, { recursive: true, force: true }); }
});

test("copy-on-write output admission is separate from immutable input leases and releases exactly", () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-output-admission-"));
  const view = createWorkerStartupView(brain);
  const limits = { allowanceBytes: 4 * 1024 * 1024, budgetBytes: 4 * 1024 * 1024 };
  let storage: ReturnType<typeof createOutputStagingStorage> | undefined;
  try {
    storage = createOutputStagingStorage(limits, view.root); storage.retain();
    expect(() => createOutputStagingStorage(limits, view.root)).toThrow("output-staging capacity");
    storage.release(); storage = undefined;
    const replacement = createOutputStagingStorage(limits, view.root); replacement.retain(); replacement.release();
    expect(existsSync(view.root), "RELEASING_OUTPUT_DOES_NOT_RELEASE_INPUT_VIEW").toBe(true);
  } finally { storage?.release(); view.cleanup(); rmSync(brain, { recursive: true, force: true }); }
});


test("abrupt server exit releases its immutable input copy and copy-on-write keeper", async () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-server-lifetime-"));
  writeFileSync(join(brain, "helper.txt"), "Odysseus retained input");
  const startupModule = new URL("./helpers/worker-startup-view-fixture.ts", import.meta.url).pathname;
  const stagingModule = new URL("../src/server/worker-launcher.ts", import.meta.url).pathname;
  const source = `import {createFixtureWorkerStartupView as createWorkerStartupView} from ${JSON.stringify(startupModule)};
import {createOutputStagingStorage} from ${JSON.stringify(stagingModule)};
const view=createWorkerStartupView(${JSON.stringify(brain)});
const storage=createOutputStagingStorage({allowanceBytes:4194304,budgetBytes:4194304},view.root);storage.retain();
console.log(JSON.stringify({root:view.storage.root,inputKeeper:view.storage.cleanupPid,outputKeeper:storage.namespacePid}));
await Bun.stdin.text();`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], { cwd: "/", env: { PATH: process.env.PATH! }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) { const next = await reader.read(); if (next.done) break; line += Buffer.from(next.value ?? []).toString(); }
    expect(line, "SERVER_ESTABLISHED_BOTH_OWNED_KEEPERS").toContain("outputKeeper");
    const receipt = JSON.parse(line);
    child.kill("SIGKILL"); await child.exited;
    const alive = (pid: number) => {
      try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z"; } catch { return false; }
    };
    const deadline = Date.now() + 5000;
    while ((existsSync(receipt.root) || alive(receipt.inputKeeper) || alive(receipt.outputKeeper)) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(receipt.root), "NO_IMMUTABLE_BYTES_LEFT_AFTER_SERVER_SIGKILL").toBe(false);
    expect(alive(receipt.inputKeeper), "NO_INPUT_CLEANUP_KEEPER_LEFT").toBe(false);
    expect(alive(receipt.outputKeeper), "NO_WRITABLE_NAMESPACE_KEEPER_LEFT").toBe(false);
    expect(readFileSync(join(brain, "helper.txt"), "utf8")).toBe("Odysseus retained input");
  } finally { child.kill("SIGKILL"); await child.exited; rmSync(brain, { recursive: true, force: true }); }
});
