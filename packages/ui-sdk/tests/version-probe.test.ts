import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVersionCommand, VERSION_PROBE_TIMEOUT_MS } from "../src/server/version-probe";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("a completed async probe clears its deadline and retains both output streams and exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "version-probe-"));
  dirs.push(dir);
  const scheduled = spyOn(globalThis, "setTimeout");
  const cleared = spyOn(globalThis, "clearTimeout");
  const rejected: unknown[] = [];
  const onRejected = (error: unknown) => { rejected.push(error); };
  process.on("unhandledRejection", onRejected);
  try {
    const result = await probeVersionCommand(["/bin/sh", "-c", "printf 'version\\n'; printf 'diagnostic\\n' >&2; sleep 0.02; exit 3"], { cwd: dir, env: {}, exec: {} });
    expect(result).toEqual({ stdout: "version\n", stderr: "diagnostic\n", exitCode: 3, timedOut: false, cleanupWarnings: [] });
    const call = scheduled.mock.calls.findIndex(args => args[1] === VERSION_PROBE_TIMEOUT_MS);
    expect(call).toBeGreaterThanOrEqual(0);
    const deadline = scheduled.mock.results[call]!.value as ReturnType<typeof setTimeout>;
    expect(cleared.mock.calls.map(args => args[0])).toContain(deadline);
    await Bun.sleep(5);
    expect(rejected).toEqual([]);
  } finally {
    scheduled.mockRestore(); cleared.mockRestore(); process.off("unhandledRejection", onRejected);
  }
});

test("giving up on an unconfirmed probe closes readers and does not keep its host alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "version-host-exit-"));
  dirs.push(dir);
  mkdirSync(join(dir, "empty"));
  const childPid = join(dir, "probe.pid");
  const binary = join(dir, "version");
  writeFileSync(binary, `#!/bin/sh\necho $$ > '${childPid}'\necho version\nexec sleep 8\n`, { mode: 0o755 });
  const wrapper = join(dir, "wrapper");
  writeFileSync(wrapper, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const killer = join(dir, "noop");
  writeFileSync(killer, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const script = join(dir, "host.ts");
  writeFileSync(script, `import {probeVersionCommand} from ${JSON.stringify(new URL("../src/server/version-probe.ts", import.meta.url).pathname)};\nconst r = await probeVersionCommand([${JSON.stringify(binary)}, "--version"], {cwd: ${JSON.stringify(dir)}, env: {}, exec: {wrapper: ${JSON.stringify(wrapper)}, killer: ${JSON.stringify(killer)}}});\nconsole.log(JSON.stringify(r));\n`);
  const host = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([host.exited, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 6_500); })]);
    expect(code).toBe(0);
    const report = JSON.parse(await new Response(host.stdout).text());
    expect(report.timedOut).toBe(true);
    expect(report.cleanupWarnings.join(" ")).toContain("Giving up waiting");
  } finally {
    clearTimeout(timer);
    host.kill("SIGKILL");
    await host.exited;
    const pid = Number(await Bun.file(childPid).text());
    if (pid > 0) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already exited. */ } }
  }
});


test("exit and deadline racing settle once, with one group sweep and no unhandled rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "version-exit-race-"));
  dirs.push(dir);
  const binary = join(dir, "version");
  writeFileSync(binary, "#!/bin/sh\necho version\nexec sleep 5\n", { mode: 0o755 });
  const wrapper = join(dir, "wrapper");
  writeFileSync(wrapper, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const log = join(dir, "killer.log");
  const killer = join(dir, "killer");
  writeFileSync(killer, `#!/bin/sh\necho "$1 $2" >> '${log}'\nkill -"$2" -"$1" 2>/dev/null || true\n`, { mode: 0o755 });
  const rejected: unknown[] = [];
  const onRejected = (error: unknown) => { rejected.push(error); };
  process.on("unhandledRejection", onRejected);
  try {
    const result = await probeVersionCommand([binary, "--version"], { cwd: dir, env: {}, exec: { wrapper, killer } });
    expect(result.stdout).toBe("version\n");
    if (!result.timedOut) expect(result.exitCode).toBe(0);
    await Bun.sleep(100);
    expect((await Bun.file(log).text()).trim().split("\n")).toHaveLength(1);
    expect(rejected).toEqual([]);
  } finally { process.off("unhandledRejection", onRejected); }
});
