/** Local tests never execute the installed native runtime, including mutations. */
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bundledClaudeBinary } from "../packages/core/src/providers/agents/claude-binary";
import { isNativeClaude } from "../scripts/test-native-guard";

const ROOT = join(import.meta.dir, "..");
const runtime = bundledClaudeBinary();
if (!runtime) throw new Error("Native boundary proof requires the installed SDK runtime identity");

async function probe(script: string, home: string) {
  const path = join(home, "probe.ts"); writeFileSync(path, script);
  const child = Bun.spawn([process.execPath, path], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, output };
}
const imports = `import {installNetworkGuard} from ${JSON.stringify(join(ROOT, "scripts/test-network-guard.ts"))};
  import {nativeClaudeBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
  delete process.env.GITHUB_ACTIONS; delete process.env.RUNNER_ENVIRONMENT; installNetworkGuard();`;

test("a harmless fixture named claude runs without native admission", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-fixture-runtime-"));
  try {
    const executable = join(scratch, "claude"), marker = join(scratch, "launched");
    writeFileSync(executable, `#!/bin/sh\nprintf launched > '${marker}'\n`); chmodSync(executable, 0o700);
    expect(isNativeClaude(executable)).toBe(false);
    const result = await probe(`${imports} import {spawn} from "node:child_process"; spawn(${JSON.stringify(executable)}, []);`, scratch);
    expect(result.code, result.output).toBe(0); expect(existsSync(marker)).toBe(true);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("worker exec payload refuses before its synthetic bootstrap starts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-worker-refusal-"));
  try {
    const marker = join(scratch, "launched");
    // The declared payload is real, but this bootstrap can only write a marker.
    // Removing admission in a mutation can never launch the installed runtime.
    const result = await probe(`${imports} Bun.spawn(["/bin/sh", "-c", ${JSON.stringify(`printf launched > '${marker}'`)}],
      {env:{BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],argv:["bwrap","--",${JSON.stringify(runtime)}]})}});`, scratch);
    expect(result.code).not.toBe(0); expect(existsSync(marker)).toBe(false);
    expect(result.output).toContain('"success":false,"nativeLaunched":false');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("catching a native refusal and exiting zero still fails the child", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-caught-refusal-"));
  try {
    // Plan admission only: no spawn of the installed runtime, even if broken.
    const result = await probe(`${imports} try { nativeClaudeBoundary(${JSON.stringify(runtime)}, [], {}); } catch {} process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"success":false,"nativeLaunched":false');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("runtime provenance follows a symlink and detects an arbitrarily named byte-identical copy", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-runtime-identity-"));
  try {
    const linked = join(scratch, "odysseus-link"), copied = join(scratch, "odysseus-copy");
    symlinkSync(runtime!, linked); copyFileSync(runtime!, copied);
    for (const path of [linked, copied]) {
      expect(isNativeClaude(path)).toBe(true);
      // Refusal planning is safe even under a broken guard: it never execs.
      const result = await probe(`${imports} nativeClaudeBoundary(${JSON.stringify(path)}, [], {});`, scratch);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('"success":false,"nativeLaunched":false');
      expect(result.output).toContain("positive native proof requires a hosted runner");
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("native identity uses the child's PATH and cwd", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-child-resolution-"));
  try {
    symlinkSync(runtime!, join(scratch, "odysseus-selected"));
    expect(isNativeClaude("odysseus-selected", [], { env: { PATH: scratch }, cwd: "/" })).toBe(true);
    expect(isNativeClaude("./odysseus-selected", [], { env: { PATH: "/usr/bin:/bin" }, cwd: scratch })).toBe(true);
    expect(isNativeClaude("/usr/bin/true", [], { env: { PATH: scratch }, cwd: scratch })).toBe(false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("missing bubblewrap emits a failed receipt and cannot be caught into success", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-missing-isolation-"));
  try {
    const result = await probe(`${imports}
      process.env.GITHUB_ACTIONS="true"; process.env.RUNNER_ENVIRONMENT="github-hosted";
      const original=Bun.spawnSync;
      Bun.spawnSync=((...args)=>{if(args[0]?.[0]==="bwrap")throw Object.assign(new Error("synthetic missing isolation"),{code:"ENOENT"});return Reflect.apply(original,Bun,args);});
      try { nativeClaudeBoundary(${JSON.stringify(runtime)}, [], {}); } catch {} process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"success":false,"nativeLaunched":false');
    expect(result.output).toContain('"reason":"OS namespace setup failed"');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("relay paths cannot redirect headers and body to another loopback service", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-relay-origin-"));
  let intended = 0, unintended = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { intended++; return new Response("Ithaca"); } });
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { unintended++; return new Response("Unintended"); } });
  try {
    const result = await probe(`${imports}
      import {startNativeTestRelay} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const relay=startNativeTestRelay(${JSON.stringify(target.url.origin)});
      try {
        const denied=await relay.handle(new Request(${JSON.stringify(`http://localhost//127.0.0.1:${other.port}/v1/messages`)},
          {method:"POST",headers:{authorization:"odysseus-fixture"},body:"synthetic"}));
        if(denied.status!==403)throw Error("relay accepted an authority path");
        const allowed=await relay.handle(new Request("http://localhost/v1/messages"));
        if(await allowed.text()!=="Ithaca")throw Error("scripted origin was unavailable");
        console.log("RELAY_AUTHORITY_REFUSED");
      } finally {relay.dispose();} process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"unintended native destination"');
    expect(unintended).toBe(0); expect(intended).toBe(1);
  } finally { target.stop(true); other.stop(true); rmSync(scratch, { recursive: true, force: true }); }
});

test("native audit counts raw kernel failures without decoding addresses or payloads", async () => {
  const { deniedNativeConnects } = await import("../scripts/test-native-guard");
  expect(deniedNativeConnects("1 connect(0x3, 0x123, 0x10) = -1 ENETUNREACH (Network is unreachable)\n2 <... connect resumed>) = -1 EACCES (Permission denied)\n3 connect(0x4, 0x456, 0x10) = 0\n4 connect(0x5, 0x789, 0x10) = -1 EINPROGRESS (Operation now in progress)")).toBe(2);
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
    const executable = join(brain, "odysseus-native-probe");
    writeFileSync(executable, `#!/usr/bin/python3
import http.client,json,os,socket,subprocess
settings=json.load(open('/etc/claude-code/managed-settings.json'))
helper=subprocess.run(settings['apiKeyHelper'],shell=True,capture_output=True)
assert helper.returncode != 0 and not helper.stdout, 'outside credential escaped'
for host,port in [('127.0.0.1',${service.port}),('198.18.0.1',1)]:
 try:
  socket.create_connection((host,port),timeout=1)
 except OSError:
  pass
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
      expect(boundary.receipt().deniedConnects).toBeGreaterThanOrEqual(2);
      expect(out).toContain("HOSTILE_MANAGED_BOUNDARY_HELD");
      expect(out + err).not.toContain("odysseus-synthetic-credential");
      expect(requests).toBe(1);
      // Restored mutation: re-expose only the synthetic outside credential.
      // The same runtime assertion must now reject the managed helper escape.
      const mutationBoundary = nativeClaudeBoundary(executable, [], { cwd: brain, env: { HOME: home, ANTHROPIC_BASE_URL: service.url.origin }, managedSettings: managed });
      const mutant = [...mutationBoundary.argv];
      mutant.splice(mutant.indexOf("--clearenv"), 0, "--ro-bind", sentinel, sentinel);
      const broken = Bun.spawn(mutant, { env: boundary.env, stdout: "pipe", stderr: "pipe" });
      const [brokenCode, brokenOut, brokenErr] = await Promise.all([broken.exited,
        new Response(broken.stdout).text(), new Response(broken.stderr).text()]);
      expect(brokenCode).not.toBe(0);
      expect(brokenErr).toContain("outside credential escaped");
      expect(brokenOut + brokenErr).not.toContain("odysseus-synthetic-credential");
      mutationBoundary.dispose();
    } finally { boundary?.dispose(); service.stop(true); rmSync(scratch, { recursive: true, force: true }); }
  });
}
