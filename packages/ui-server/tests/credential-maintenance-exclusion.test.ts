import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostCredentialExclusion, createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { resolveClaudeHostOAuth } from "../../ui-backend-claude/src/host-oauth.js";
import { createHostBoundary, hostExecution, type StreamingExecution } from "../src/brain/host-boundary.js";
import { createUiDb } from "../src/db/client.js";
import { createWriterGate } from "../src/brain/writer-gate.js";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";

const roots: string[] = [];
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-credential-maintenance-")); roots.push(root);
  const brain = join(root, "brain"), home = join(root, "home"), config = join(home, ".claude"), directory = join(root, "credential-domain");
  mkdirSync(brain); mkdirSync(home, { mode: 0o700 }); mkdirSync(config, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(root, "state"), { mode: 0o700 });
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "odysseus-maintenance-only-token",
    refreshToken: "odysseus-maintenance-only-refresh", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"], subscriptionType: "max" } }), { mode: 0o600 });
  return { root, brain, home, config, domain: { directory } };
}
async function complete(process: StreamingExecution) {
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, exit };
}

test("real isolated credentialed maintenance admits its writer before waiting, excludes host auth, then releases after native output", async () => {
  const f = fixture();
  // The existing native-app fixture supplies input acquisition. The actual
  // namespace and command remain real; this is not Btrfs storage qualification.
  const native = createNativeAppFixture(f.brain); cleanup.push(native.close);
  let entered!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  let writerHeld = false;
  const gate = { async acquire() { writerHeld = true; entered(); return { id: "odysseus", mode: "exclusive" as const, release() { writerHeld = false; } }; }, holders: () => [] };
  const boundary = createHostBoundary({ brainPath: f.brain, nativeManager: createNativeBrainManagerClient(native.nativeBrain),
    dbPath: join(f.root, "state/ui.db"), home: f.home, credentialDomain: f.domain, gate: () => gate });
  const held = await acquireHostCredentialExclusion({ domain: f.domain }); cleanup.push(() => held.release());
  const release = join(f.home, "release"), credential = join(f.config, ".credentials.json");
  const script = `import {existsSync,readFileSync,readlinkSync} from "node:fs";
    const credential=JSON.parse(readFileSync(${JSON.stringify(credential)},"utf8"));
    console.log(JSON.stringify({entered:true,access:credential.claudeAiOauth.accessToken,mount:readlinkSync("/proc/self/ns/mnt")}));
    while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(10);`;
  const pending = boundary.launch({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", script],
    env: { PATH: "/usr/bin:/bin" }, credentials: true, gate: "exclusive", purpose: "Odysseus credential maintenance" });
  await admitted;
  expect(writerHeld, "WRITER_ADMITTED_BEFORE_CREDENTIAL_WAIT").toBe(true);
  held.release();
  const child = await pending;
  const reader = child.stdout.getReader();
  cleanup.push(async () => {
    child.kill("SIGKILL");
    await Promise.all([reader.cancel(), child.stderr.locked ? Promise.resolve() : child.stderr.cancel(), child.exited]);
  });
  const first = await reader.read();
  const observed = JSON.parse(new TextDecoder().decode(first.value));
  expect(observed).toMatchObject({ entered: true, access: "odysseus-maintenance-only-token" });
  expect(observed.mount, "ACTUAL_MAINTENANCE_NAMESPACE").not.toBe(readlinkSync("/proc/self/ns/mnt"));
  await expect(resolveClaudeHostOAuth(f.config, {}, undefined, f.domain)).rejects.toMatchObject({ reason: "busy" });
  writeFileSync(release, "Odysseus maintenance complete");
  while (!(await reader.read()).done) { /* Preserve the native EOF barrier. */ }
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0); expect(stderr).toBe("");
  const next = await acquireHostCredentialExclusion({ domain: f.domain, timeoutMs: 1000 }); next.release();
  expect((await resolveClaudeHostOAuth(f.config, {}, undefined, f.domain)).source).toBe("stored-login");
  expect(writerHeld).toBe(false);
});

test("cancelled credential admission releases writer admission without releasing the credential owner", async () => {
  const f = fixture();
  const native = createNativeAppFixture(f.brain); cleanup.push(native.close);
  let entered!: () => void; const admitted = new Promise<void>(resolve => { entered = resolve; });
  let writerHeld = false;
  const gate = { async acquire() { writerHeld = true; entered(); return { id: "odysseus", mode: "exclusive" as const, release() { writerHeld = false; } }; }, holders: () => [] };
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.root, "state/ui.db"), nativeManager: createNativeBrainManagerClient(native.nativeBrain), credentialDomain: f.domain, gate: () => gate });
  const hold = await acquireHostCredentialExclusion({ domain: f.domain }); cleanup.push(() => hold.release());
  const abort = new AbortController();
  const pending = boundary.launch({ argv: [process.execPath, "-e", "console.log('should not start')"], env: { PATH: "/usr/bin:/bin" },
    credentials: true, gate: "exclusive", purpose: "Odysseus cancelled admission", signal: abort.signal });
  await admitted; abort.abort(new Error("odysseus-cancel"));
  await expect(pending).rejects.toBeDefined();
  expect(writerHeld).toBe(false);
  await expect(acquireHostCredentialExclusion({ domain: f.domain })).rejects.toMatchObject({ reason: "busy" });
});

test("streaming outer exit keeps credentials excluded until a real descendant closes inherited output", async () => {
  const f = fixture();
  // Select only the supported legacy path; this control claims process/output
  // lifecycle, not managed storage or namespace isolation.
  const probe = spyOn(hostExecution, "probe").mockReturnValue({ ok: false, requirement: "fictional legacy fixture" });
  cleanup.push(() => probe.mockRestore());
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.root, "state/ui.db"), credentialDomain: f.domain });
  const release = join(f.root, "release");
  const descendant = `import {existsSync} from "node:fs";console.log("descendant");while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(10);`;
  const script = `const child=Bun.spawn([process.execPath,"--config=/dev/null","--no-env-file","-e",${JSON.stringify(descendant)}],{stdin:"ignore",stdout:"inherit",stderr:"inherit",env:{PATH:"/usr/bin:/bin"}});child.unref();`;
  const child = await boundary.launch({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", script],
    env: { PATH: "/usr/bin:/bin" }, credentials: true, gate: "none", purpose: "Odysseus inherited output" });
  const draining = complete(child);
  cleanup.push(async () => { writeFileSync(release, "Odysseus closes output"); await draining; });
  expect(await child.exited).toBe(0);
  // Settle the outer process's exit callbacks while its descendant still
  // waits on the explicit release file and owns both output descriptors.
  await new Promise<void>(resolve => setImmediate(resolve));
  await expect(acquireHostCredentialExclusion({ domain: f.domain })).rejects.toMatchObject({ reason: "busy" });
  writeFileSync(release, "Odysseus closes output");
  const result = await draining;
  expect(result.stdout).toBe("descendant\n"); expect(result.stderr).toBe("");
  const next = await acquireHostCredentialExclusion({ domain: f.domain, timeoutMs: 1000 }); next.release();
});

test("asynchronous credentialed run excludes refresh until the actual command and output finish", async () => {
  const f = fixture();
  const probe = spyOn(hostExecution, "probe").mockReturnValue({ ok: false, requirement: "fictional legacy fixture" });
  cleanup.push(() => probe.mockRestore());
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.root, "state/ui.db"), credentialDomain: f.domain });
  const entered = join(f.root, "entered"), release = join(f.root, "release");
  const script = `import {existsSync,writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(entered)},"entered");
    while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(10);console.log("Odysseus maintenance complete");`;
  const running = boundary.run({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", script],
    env: { PATH: "/usr/bin:/bin" }, credentials: true, gate: "none", purpose: "Odysseus credentialed run" });
  cleanup.push(async () => { writeFileSync(release, "released"); await running; });
  const deadline = performance.now() + 5000;
  while (!existsSync(entered) && performance.now() < deadline) await Bun.sleep(5);
  expect(existsSync(entered), "ACTUAL_CREDENTIAL_COMMAND_ENTERED").toBe(true);
  await expect(resolveClaudeHostOAuth(f.config, {}, undefined, f.domain)).rejects.toMatchObject({ reason: "busy" });
  writeFileSync(release, "released");
  expect(await running).toMatchObject({ stdout: "Odysseus maintenance complete\n", stderr: "", exitCode: 0 });
  const hold = await acquireHostCredentialExclusion({ domain: f.domain, timeoutMs: 1000 }); hold.release();
});

test("a failed native output read kills the credentialed run and retains exclusion through remaining descendant output", async () => {
  const f = fixture();
  const probe = spyOn(hostExecution, "probe").mockReturnValue({ ok: false, requirement: "fictional legacy fixture" });
  cleanup.push(() => probe.mockRestore());
  const db = createUiDb(join(f.root, "state/ui.db")); cleanup.push(() => db.close());
  const gate = createWriterGate(db, f.brain);
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.root, "state/ui.db"), credentialDomain: f.domain, gate: () => gate, requireGate: true });
  const entered = join(f.root, "descendant-entered"), release = join(f.root, "release");
  const descendant = `import {existsSync,writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(entered)},"entered");
    console.error("Odysseus descendant");while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(10);`;
  const script = `const child=Bun.spawn([process.execPath,"--config=/dev/null","--no-env-file","-e",${JSON.stringify(descendant)}],
    {stdin:"ignore",stdout:"ignore",stderr:"inherit",env:{PATH:"/usr/bin:/bin"}});child.unref();while(true)await Bun.sleep(10);`;
  const nativeSpawn = Bun.spawn;
  let actual: ReturnType<typeof Bun.spawn> | undefined, killed = false;
  const injected = new Error("Odysseus native output read failed");
  // The actual program and descendant remain native. Replace only the
  // failing pipe at the lowest spawn result, after the descendant entered.
  const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const process = nativeSpawn(argv, options);
    if (!argv.includes(script)) return process;
    actual = process;
    const stdout = new ReadableStream<Uint8Array>({ async start(controller) {
      const deadline = performance.now() + 5000;
      while (!existsSync(entered) && performance.now() < deadline) await Bun.sleep(5);
      controller.error(injected);
    } });
    return new Proxy(process, { get(target, key) {
      if (key === "stdout") return stdout;
      if (key === "kill") return (signal: NodeJS.Signals) => { killed = true; target.kill(signal); };
      return Reflect.get(target, key, target);
    } });
  }) as typeof Bun.spawn);
  cleanup.push(() => spawn.mockRestore());
  let settled = false;
  const running = boundary.run({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", script],
    env: { PATH: "/usr/bin:/bin" }, credentials: true, gate: "shared", purpose: "Odysseus failed output" });
  const outcome = running.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  cleanup.push(async () => { writeFileSync(release, "released"); actual?.kill("SIGKILL"); await outcome; });
  const deadline = performance.now() + 5000;
  while (!killed && !settled && performance.now() < deadline) await Bun.sleep(5);
  expect(existsSync(entered), "ACTUAL_DESCENDANT_ENTERED").toBe(true);
  expect(killed, "FAILED_OUTPUT_KILLS_NATIVE_COMMAND_WITHOUT_SIGNAL_OPTION").toBe(true);
  expect(settled, "REJECTION_WAITS_FOR_REMAINING_NATIVE_OUTPUT").toBe(false);
  expect(gate.holders(), "FAILED_HOST_OUTPUT_RETAINS_WRITER_ADMISSION").toMatchObject([{ mode: "shared" }]);
  await expect(acquireHostCredentialExclusion({ domain: f.domain })).rejects.toMatchObject({ reason: "busy" });
  writeFileSync(release, "released");
  expect(await outcome).toBe(injected);
  expect(gate.holders()).toEqual([]);
  const hold = await acquireHostCredentialExclusion({ domain: f.domain, timeoutMs: 1000 }); hold.release();
});

test("credentialed synchronous execution refuses before a host program can run", () => {
  const f = fixture();
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.root, "state/ui.db"), credentialDomain: f.domain });
  const sentinel = join(f.root, "should-not-run");
  expect(() => boundary.runSync({ argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`],
    env: { PATH: "/usr/bin:/bin" }, credentials: true, purpose: "Odysseus sync refusal", timeoutMs: 1000 })).toThrow("requires asynchronous");
  expect(existsSync(sentinel)).toBe(false);
});
