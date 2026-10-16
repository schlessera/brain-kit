/** Actual legacy host children still owe their declared writer admission. */
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostBoundary, type BrainExecution, type StreamingExecution } from "../src/brain/host-boundary.js";
import { createWriterGate, type GateHold } from "../src/brain/writer-gate.js";
import { createUiDb } from "../src/db/client.js";
import { acquireHostCredentialExclusion } from "@schlessera/brain-ui-sdk/internal";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-host-gate-")), brain = join(root, "brain");
  mkdirSync(brain); mkdirSync(join(root, "state"));
  const dbPath = join(root, "state/ui.db"), db = createUiDb(dbPath), gate = createWriterGate(db, brain, { pollMs: 5 });
  const abort = new AbortController(), pending: Promise<unknown>[] = [], children: StreamingExecution[] = [], holds: GateHold[] = [];
  const boundary = (required = true, attached = true) => createHostBoundary({ brainPath: brain, dbPath,
    requireGate: required, gate: () => attached ? gate : null,
    workerHost: () => ({ ok: false, requirement: "fictional never-governed fixture" }) });
  const ready = join(root, "ready"), release = join(root, "release");
  const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(ready)},"ready");while(!fs.existsSync(${JSON.stringify(release)}))await Bun.sleep(5);console.log("Odysseus finished");`;
  const command = (mode: BrainExecution["gate"], program = script): BrainExecution => ({
    argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program], env: { PATH: "/usr/bin:/bin" },
    credentials: false, gate: mode, purpose: "Odysseus host writer", signal: abort.signal,
  });
  const start = (method: "run" | "launch", mode: BrainExecution["gate"], selected = boundary(), program = script) => {
    const running = method === "run" ? selected.run(command(mode, program)) : selected.launch(command(mode, program)).then(async child => {
      children.push(child);
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    });
    pending.push(running.catch(() => {})); return running;
  };
  return { root, brain, gate, boundary, command, start, ready, release, holds, abort,
    async close() {
      writeFileSync(release, "released"); abort.abort();
      for (const child of children) child.kill("SIGKILL");
      for (const hold of holds) hold.release();
      await Promise.all(pending); db.close(); rmSync(root, { recursive: true, force: true });
    },
  };
}
async function ready(path: string) {
  const deadline = performance.now() + 5000;
  while (!existsSync(path) && performance.now() < deadline) await Bun.sleep(5);
  expect(existsSync(path), "ACTUAL_HOST_CHILD_ENTERED").toBe(true);
}

for (const method of ["run", "launch"] as const) {
  test(`${method}: a shared host child is accounted and remains concurrent with another shared holder`, async () => {
    const f = fixture();
    try {
      expect(f.boundary().isolated()).toBe(false);
      const running = f.start(method, "shared"); await ready(f.ready);
      expect(f.gate.holders(), "LEGACY_HOST_WRITER_ACCOUNTED").toMatchObject([{ mode: "shared", purpose: "Odysseus host writer" }]);
      const peer = await f.gate.acquire("shared", "Odysseus peer"); f.holds.push(peer);
      expect(f.gate.holders()).toHaveLength(2); peer.release();
      writeFileSync(f.release, "released");
      expect(await running).toEqual({ stdout: "Odysseus finished\n", stderr: "", exitCode: 0 });
      const after = await f.gate.acquire("exclusive", "after host exit"); f.holds.push(after);
      expect(f.gate.holders()).toHaveLength(1);
    } finally { await f.close(); }
  });

  test(`${method}: required missing admission refuses before any actual host child starts`, async () => {
    const f = fixture();
    try {
      const running = f.start(method, "shared", f.boundary(true, false), `require("node:fs").writeFileSync(${JSON.stringify(f.ready)},"unexpected");`);
      await expect(running, "REQUIRED_HOST_GATE_REFUSES_BEFORE_SPAWN").rejects.toThrow("needs the brain's writer gate");
      expect(existsSync(f.ready)).toBe(false);
    } finally { await f.close(); }
  });

  test(`${method}: exclusive admission waits for shared and prevents a new shared child`, async () => {
    const f = fixture();
    try {
      const peer = await f.gate.acquire("shared", "existing shared peer"); f.holds.push(peer);
      const running = f.start(method, "exclusive");
      await Bun.sleep(30);
      expect(existsSync(f.ready), "HOST_EXCLUSIVE_WAITS_FOR_SHARED").toBe(false);
      peer.release(); await ready(f.ready);
      expect(f.gate.holders()).toMatchObject([{ mode: "exclusive" }]);
      const abort = new AbortController(); let entered = false;
      const blocked = f.gate.acquire("shared", "blocked shared", { signal: abort.signal }).then(hold => { entered = true; f.holds.push(hold); }, () => {});
      await Bun.sleep(30); expect(entered, "HOST_EXCLUSIVE_BLOCKS_SHARED").toBe(false);
      abort.abort(); await blocked;
      writeFileSync(f.release, "released"); expect((await running).exitCode).toBe(0);
    } finally { await f.close(); }
  });

  test(`${method}: optional missing gate and trusted gate-none keep the legacy path`, async () => {
    const f = fixture();
    try {
      for (const [mode, selected] of [["shared", f.boundary(false, false)], ["none", f.boundary(true, false)]] as const) {
        expect(await f.start(method, mode, selected, 'console.log("Odysseus reads");')).toEqual({ stdout: "Odysseus reads\n", stderr: "", exitCode: 0 });
      }
      expect(f.gate.holders()).toEqual([]);
    } finally { await f.close(); }
  });

  test(`${method}: aborted and failed host execution releases only its own admission`, async () => {
    const f = fixture();
    try {
      const peer = await f.gate.acquire("shared", "retained peer"); f.holds.push(peer);
      const running = f.start(method, "shared");
      const result = running.then(value => value, error => error);
      await ready(f.ready); expect(f.gate.holders()).toHaveLength(2);
      f.abort.abort(new Error("Odysseus cancelled"));
      const outcome = await result;
      if (method === "run") expect(outcome).toBeInstanceOf(Error);
      else expect(outcome.exitCode).not.toBe(0);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.gate.holders()).toMatchObject([{ mode: "shared", purpose: "retained peer" }]);
      // Positive exclusive admission waits for asynchronous pipe cleanup.
      peer.release();
      const after = await f.gate.acquire("exclusive", "after cancelled host"); f.holds.push(after);
      expect(f.gate.holders()).toHaveLength(1); after.release();
      const failed = f.boundary()[method]({ ...f.command("shared"), signal: undefined, argv: [join(f.root, "missing-program")] });
      await expect(failed).rejects.toBeDefined();
      expect(f.gate.holders()).toEqual([]);
    } finally { await f.close(); }
  });

  test(`${method}: sticky worker selection is rechecked after writer admission waits`, async () => {
    const f = fixture(); let history = false;
    const selected = createHostBoundary({ brainPath: f.brain, gate: () => f.gate, requireGate: true,
      history: () => history, workerHost: () => ({ ok: false, requirement: "fictional earlier host" }) });
    try {
      const exclusive = await f.gate.acquire("exclusive", "existing exclusive owner"); f.holds.push(exclusive);
      const running = f.start(method, "shared", selected);
      const outcome = running.then(value => value, error => error);
      await Bun.sleep(30); expect(existsSync(f.ready)).toBe(false);
      history = true; exclusive.release();
      expect(String(await outcome), "HOST_SELECTION_RECHECKS_STICKY_HISTORY").toContain("requires the configured native managed-storage manager");
      expect(existsSync(f.ready)).toBe(false); expect(f.gate.holders()).toEqual([]);
    } finally { await f.close(); }
  });

  test(`${method}: sticky worker selection is rechecked after credential exclusion waits`, async () => {
    const f = fixture(); let history = false;
    const directory = join(f.root, "credentials"); mkdirSync(directory, { mode: 0o700 });
    const domain = { directory }, held = await acquireHostCredentialExclusion({ domain });
    const selected = createHostBoundary({ brainPath: f.brain, gate: () => f.gate, requireGate: true, credentialDomain: domain,
      history: () => history, workerHost: () => ({ ok: false, requirement: "fictional earlier host" }) });
    const nativeSpawn = Bun.spawnSync; let credentialWait = false;
    const observing = spyOn(Bun, "spawnSync").mockImplementation(((argv: string[], options: Parameters<typeof Bun.spawnSync>[1]) => {
      const result = nativeSpawn(argv, options);
      if (argv[0]?.endsWith("/flock") && result.exitCode === 1) credentialWait = true;
      return result;
    }) as typeof Bun.spawnSync);
    try {
      const command = { ...f.command("shared"), credentials: true };
      const running = selected[method](command);
      let settled = false;
      const outcome = running.then(value => { settled = true; return value; }, error => { settled = true; return error; });
      const deadline = performance.now() + 5000;
      while (!credentialWait && performance.now() < deadline) await Bun.sleep(5);
      expect(credentialWait, "ACTUAL_HOST_CREDENTIAL_EXCLUSION_BLOCKED").toBe(true);
      expect(f.gate.holders(), "WRITER_ADMITTED_BEFORE_HOST_CREDENTIAL_WAIT").toHaveLength(1);
      expect(existsSync(f.ready)).toBe(false);
      history = true; held.release();
      // Release a wrongly spawned fixture child so the negative control fails
      // on its named assertion rather than a harness timeout.
      const finishBy = performance.now() + 5000;
      while (!settled && !existsSync(f.ready) && performance.now() < finishBy) await Bun.sleep(5);
      if (existsSync(f.ready)) writeFileSync(f.release, "unexpected host child released");
      const result = await outcome;
      if (method === "launch" && !(result instanceof Error)) {
        result.kill("SIGKILL"); await Promise.all([result.stdout.cancel(), result.stderr.cancel(), result.exited]);
      }
      expect(String(result), "CREDENTIAL_WAIT_RECHECKS_STICKY_HISTORY").toContain("requires the configured native managed-storage manager");
      expect(existsSync(f.ready)).toBe(false); expect(f.gate.holders()).toEqual([]);
    } finally { observing.mockRestore(); held.release(); await f.close(); }
  });
}

test("streaming parent exit retains writer admission until its actual descendant closes inherited output", async () => {
  const f = fixture();
  const descendant = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(f.ready)},"ready");while(!fs.existsSync(${JSON.stringify(f.release)}))await Bun.sleep(5);console.log("Odysseus descendant");`;
  const parent = `const child=Bun.spawn([process.execPath,"--config=/dev/null","--no-env-file","-e",${JSON.stringify(descendant)}],{stdin:"ignore",stdout:"inherit",stderr:"inherit",env:{PATH:"/usr/bin:/bin"}});child.unref();`;
  try {
    const child = await f.boundary().launch(f.command("shared", parent));
    const draining = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    try {
      await ready(f.ready); expect(await child.exited).toBe(0);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.gate.holders(), "HOST_GATE_RETAINS_DESCENDANT_OUTPUT").toMatchObject([{ mode: "shared" }]);
    } finally { writeFileSync(f.release, "released"); await child.exited; await draining; }
    const after = await f.gate.acquire("exclusive", "after descendant EOF"); f.holds.push(after);
    expect(f.gate.holders()).toHaveLength(1);
  } finally { await f.close(); }
});
