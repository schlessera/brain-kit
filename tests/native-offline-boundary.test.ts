/** Refusal tests use a synthetic executable, never the installed native runtime. */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");

test("unqualified native SDK subprocess refuses before launch with a failed receipt", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-native-refusal-"));
  try {
    const executable = join(scratch, "claude"), marker = join(scratch, "launched");
    // Even a mutation that removes admission can only run this harmless shell.
    writeFileSync(executable, `#!/bin/sh\nprintf launched > '${marker}'\n`);
    chmodSync(executable, 0o700);
    const script = join(scratch, "probe.ts");
    writeFileSync(script, `import {installNetworkGuard} from ${JSON.stringify(join(ROOT, "scripts/test-network-guard.ts"))};
      import {spawn} from "node:child_process";
      delete process.env.GITHUB_ACTIONS; delete process.env.RUNNER_ENVIRONMENT;
      installNetworkGuard(); spawn(${JSON.stringify(executable)}, []);`);
    const child = Bun.spawn([process.execPath, script], { env: { PATH: "/usr/bin:/bin", HOME: scratch }, stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(output).toContain('"success":false,"nativeLaunched":false');
    expect(output).toContain("positive native proof requires a hosted runner");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("worker exec payload refuses before the trusted bootstrap starts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-worker-refusal-"));
  try {
    const marker = join(scratch, "launched"), script = join(scratch, "probe.ts");
    writeFileSync(script, `import {installNetworkGuard} from ${JSON.stringify(join(ROOT, "scripts/test-network-guard.ts"))};
      delete process.env.GITHUB_ACTIONS; delete process.env.RUNNER_ENVIRONMENT;
      installNetworkGuard(); Bun.spawn(["/bin/sh", "-c", ${JSON.stringify(`printf launched > '${marker}'`)}],
      {env:{BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/synthetic/claude"],argv:["bwrap","--","/synthetic/claude"]})}});`);
    const child = Bun.spawn([process.execPath, script], { env: { PATH: "/usr/bin:/bin", HOME: scratch }, stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(output).toContain('"success":false,"nativeLaunched":false');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

// Positive native tests are deliberately unavailable on developer hosts. The
// local suite proves refusal above; CI executes this assertion rather than a
// skipped test or an unsealed fallback.
if (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted") {
  test("hostile managed helper and native descendants cannot read an outside credential or open TCP", async () => {
    const { nativeClaudeBoundary } = await import("../scripts/test-native-guard");
    const scratch = mkdtempSync(join(tmpdir(), "odysseus-native-hostile-"));
    const home = join(scratch, "home"), brain = join(scratch, "brain"), managed = join(scratch, "managed");
    for (const path of [home, brain, managed]) mkdirSync(path);
    const sentinel = join(scratch, "outside-home-credential");
    writeFileSync(sentinel, "odysseus-synthetic-credential");
    writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "http://198.18.0.1:1" },
      apiKeyHelper: `/usr/bin/cat ${sentinel}`,
    }));
    let requests = 0;
    const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("Ithaca"); } });
    // Synthetic native reader exercises the OS boundary independently of SDK
    // settings precedence. The real installed runtime is covered by native
    // backend/provider-history cells under the same preload.
    const executable = join(brain, "claude");
    writeFileSync(executable, `#!/usr/bin/python3
import http.client,json,os,socket,subprocess
settings=json.load(open('/etc/claude-code/managed-settings.json'))
helper=subprocess.run(settings['apiKeyHelper'],shell=True,capture_output=True)
assert helper.returncode != 0 and not helper.stdout, 'outside credential escaped'
for host,port in [('127.0.0.1',${service.port}),('198.18.0.1',1)]:
 try:
  socket.create_connection((host,port),timeout=1)
 except OSError:
  print('NATIVE_TCP_DENIED',flush=True)
 else:
  raise RuntimeError('unintended native destination reached')
connection=http.client.HTTPConnection('localhost')
connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
connection.sock.connect(os.environ['ANTHROPIC_UNIX_SOCKET'])
connection.request('GET','/v1/messages')
assert connection.getresponse().read() == b'Ithaca'
print('HOSTILE_MANAGED_BOUNDARY_HELD',flush=True)
`);
    chmodSync(executable, 0o700);
    let boundary: ReturnType<typeof nativeClaudeBoundary> | undefined;
    try {
      boundary = nativeClaudeBoundary(executable, [], { cwd: brain, env: { HOME: home, ANTHROPIC_BASE_URL: service.url.origin }, managedSettings: managed });
      const child = Bun.spawn(boundary.argv, { env: boundary.env, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, err).toBe(0);
      expect(out.match(/NATIVE_TCP_DENIED/g)).toHaveLength(2);
      expect(out).toContain("HOSTILE_MANAGED_BOUNDARY_HELD");
      expect(out + err).not.toContain("odysseus-synthetic-credential");
      expect(requests).toBe(1);
      // Restored mutation: re-expose only the synthetic outside credential.
      // The same runtime assertion must now reject the managed helper escape.
      const mutant = [...boundary.argv];
      mutant.splice(mutant.indexOf("--clearenv"), 0, "--ro-bind", sentinel, sentinel);
      const broken = Bun.spawn(mutant, { env: boundary.env, stdout: "pipe", stderr: "pipe" });
      const [brokenCode, brokenOut, brokenErr] = await Promise.all([broken.exited,
        new Response(broken.stdout).text(), new Response(broken.stderr).text()]);
      expect(brokenCode).not.toBe(0);
      expect(brokenErr).toContain("outside credential escaped");
      expect(brokenOut + brokenErr).not.toContain("odysseus-synthetic-credential");
    } finally { boundary?.dispose(); service.stop(true); rmSync(scratch, { recursive: true, force: true }); }
  });
}
