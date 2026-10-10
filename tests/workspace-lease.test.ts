import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const project = resolve(import.meta.dir, "..");
const helper = pathToFileURL(join(project, "scripts/workspace-lease.mjs")).href;
const node = Bun.which("node")!;
const dirs: string[] = [], children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  const owned = children.splice(0);
  for (const child of owned) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(owned.map(child => child.exited));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(leaseHelper = helper, pauseBeforeRemoval = false) {
  const root = mkdtempSync(join(tmpdir(), "brain-workspace-lease-")); dirs.push(root);
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "odysseus-build-fixture", type: "module", exports: "./dist/index.js" }));
  writeFileSync(join(root, "dist/index.js"), 'export const captain = "Odysseus";\n');
  writeFileSync(join(root, "runner.mjs"), `
import {ensureWorkspaceLease,inheritWorkspaceLease} from ${JSON.stringify(leaseHelper)};
import {spawn} from "node:child_process";
import {existsSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
const [root,mode,action,id]=process.argv.slice(2);
const coordinated=await ensureWorkspaceLease(root,mode);
if(coordinated!==undefined)process.exit(coordinated);
writeFileSync(join(root,id+"-entered"),String(process.pid));
if(action==="writer"||action==="hold") {
  if(action==="writer") {
    if(${pauseBeforeRemoval})while(!existsSync(join(root,id+"-continue")))await delay(5);
    rmSync(join(root,"dist/index.js"));
    writeFileSync(join(root,id+"-removed"),"removed\\n");
  }
  while(!existsSync(join(root,id+"-release")))await delay(5);
  if(action==="writer")writeFileSync(join(root,"dist/index.js"),'export const captain = "Odysseus";\\n');
} else if(action==="reader") {
  try {const value=await import(join(root,"dist/index.js"));writeFileSync(join(root,id+"-result"),value.captain);}
  catch(error){console.error("PACKAGE_EXPORT_UNAVAILABLE",error.code);process.exit(1);}
} else if(action==="build") {
  const child=spawn(process.env.BUN_LEASE_TEST,["--preload",process.env.GUARD_LEASE_TEST,join(root,"scripts/build.ts")],inheritWorkspaceLease({stdio:["ignore","pipe","pipe"],env:{PATH:join(root,"bin")}}));
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  process.exit(await new Promise(resolve=>child.on("exit",code=>resolve(code??1))));
}
`);
  return root;
}

function start(root: string, mode: "read" | "write", action: string, id: string) {
  const child = Bun.spawn([node, join(root, "runner.mjs"), root, mode, action, id], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, BUN_LEASE_TEST: process.execPath, GUARD_LEASE_TEST: join(project, "scripts/test-network-child-preload.ts") },
  });
  children.push(child);
  return { child, stdout: new Response(child.stdout).text(), stderr: new Response(child.stderr).text() };
}

async function waitForMarker(root: string, id: string, phase: "entered" | "removed") {
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(root, id + "-" + phase))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}: ${phase}`);
    await Bun.sleep(5);
  }
}
const entered = (root: string, id: string) => waitForMarker(root, id, "entered");
const removed = (root: string, id: string) => waitForMarker(root, id, "removed");
const release = (root: string, id: string) => writeFileSync(join(root, id + "-release"), "release\n");

test("writer removal readiness waits beyond entry notification through a controlled gap", async () => {
  const root = fixture(helper, true), other = fixture();
  const writer = start(root, "write", "writer", "writer");
  await entered(root, "writer");
  expect(existsSync(join(root, "dist/index.js"))).toBe(true);
  expect(existsSync(join(root, "writer-removed"))).toBe(false);
  let removalReady = false;
  const ready = removed(root, "writer").then(() => { removalReady = true; });
  // Observe a real independent import while the writer is held at the gap.
  const independent = start(other, "read", "reader", "other");
  expect(await independent.child.exited, await independent.stderr).toBe(0);
  expect(readFileSync(join(other, "other-result"), "utf8")).toBe("Odysseus");
  expect(removalReady).toBe(false);
  writeFileSync(join(root, "writer-continue"), "continue\n");
  await ready;
  expect(existsSync(join(root, "dist/index.js"))).toBe(false);
  release(root, "writer");
  expect(await writer.child.exited, await writer.stderr).toBe(0);
  expect(readFileSync(join(root, "dist/index.js"), "utf8")).toContain('captain = "Odysseus"');
});

test("a live export reader waits through removal and publication; another worktree remains independent", async () => {
  const root = fixture(), other = fixture();
  const writer = start(root, "write", "writer", "writer");
  await removed(root, "writer");
  expect(existsSync(join(root, "dist/index.js"))).toBe(false);
  const reader = start(root, "read", "reader", "reader");
  const independent = start(other, "read", "reader", "other");
  expect(await independent.child.exited).toBe(0);
  expect(readFileSync(join(other, "other-result"), "utf8")).toBe("Odysseus");
  // Give the actual import a bounded opportunity to fail in the mutation arm.
  await Bun.sleep(200);
  release(root, "writer");
  expect(await writer.child.exited).toBe(0);
  const code = await reader.child.exited;
  const diagnostic = await reader.stderr;
  expect({ code, diagnostic: diagnostic.includes("PACKAGE_EXPORT_UNAVAILABLE") }).toEqual({ code: 0, diagnostic: false });
  expect(readFileSync(join(root, "reader-result"), "utf8")).toBe("Odysseus");
});

test("shared verification overlaps, blocks a writer and rejects a nested build before output removal", async () => {
  const root = fixture();
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "packages/geo/dist"), { recursive: true });
  writeFileSync(join(root, "packages/geo/dist/retained"), "retained\n");
  for (const name of ["build.ts", "publishable-packages.ts", "workspace-lease.mjs"]) copyFileSync(join(project, "scripts", name), join(root, "scripts", name));
  writeFileSync(join(root, "bin/bunx"), "#!/bin/sh\nexit 77\n", { mode: 0o755 });
  const first = start(root, "read", "hold", "first"), second = start(root, "read", "hold", "second");
  await Promise.all([entered(root, "first"), entered(root, "second")]);
  const nested = start(root, "read", "build", "nested");
  expect(await nested.child.exited).toBe(1);
  expect(await nested.stderr).toContain("Read-only verification cannot rebuild or remove workspace output");
  expect(readFileSync(join(root, "packages/geo/dist/retained"), "utf8")).toBe("retained\n");
  const writer = start(root, "write", "reader", "writer");
  await Bun.sleep(100);
  expect(existsSync(join(root, "writer-entered"))).toBe(false);
  release(root, "first"); expect(await first.child.exited).toBe(0);
  expect(existsSync(join(root, "writer-entered"))).toBe(false);
  release(root, "second"); expect(await second.child.exited).toBe(0);
  expect(await writer.child.exited).toBe(0);
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) test(`${signal} of the outer command stops its owner and admits the waiting command`, async () => {
  const root = fixture();
  const owner = start(root, "write", "hold", "owner");
  await entered(root, "owner");
  const ownedPid = Number(readFileSync(join(root, "owner-entered"), "utf8"));
  const waiter = start(root, "write", "reader", "waiter");
  owner.child.kill(signal);
  expect(await owner.child.exited).not.toBe(0);
  expect(await waiter.child.exited).toBe(0);
  expect(() => process.kill(ownedPid, 0)).toThrow();
});

async function cancelledWaiter(signal: "SIGTERM" | "SIGKILL", leaseHelper = helper) {
  const root = fixture(leaseHelper), holder = start(root, "write", "hold", "holder");
  await entered(root, "holder");
  const waiter = start(root, "write", "reader", "cancelled");
  const descendants = (pid: number): number[] => {
    try {
      const direct = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(" ").filter(Boolean).map(Number);
      return direct.flatMap(child => [child, ...descendants(child)]);
    } catch { return []; }
  };
  const alive = (pid: number) => {
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z"; }
    catch { return false; }
  };
  let owned: number[] = [];
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      owned = descendants(waiter.child.pid);
      if (owned.some(pid => { try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "flock"; } catch { return false; } })) break;
      await Bun.sleep(5);
    }
    expect(owned.length).toBeGreaterThan(0);
    waiter.child.kill(signal);
    expect(await waiter.child.exited).not.toBe(0);
    const stoppedBy = Date.now() + 2_000;
    while (owned.some(alive) && Date.now() < stoppedBy) await Bun.sleep(5);
    const remaining = owned.filter(alive);
    const evidence = remaining.map(pid => {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8").split("\n")
          .filter(line => /^(Name|State|PPid|SigBlk|SigIgn|SigCgt):/.test(line));
        const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
        return { pid, status, command };
      } catch { return { pid, gone: true }; }
    });
    expect(remaining, JSON.stringify(evidence)).toEqual([]);
    expect(existsSync(join(root, "cancelled-entered"))).toBe(false);
  } finally {
    for (const pid of owned.filter(alive)) { try { process.kill(pid, "SIGTERM"); } catch { /* Already stopped. */ } }
    release(root, "holder"); await holder.child.exited;
  }
}

for (const signal of ["SIGTERM", "SIGKILL"] as const) test(`${signal} while waiting removes the waiter before the current owner releases access`, async () => {
  await cancelledWaiter(signal);
});

test("SIGTERM during the native flock startup gap cannot orphan a cancelled waiter", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-lease-startup-")); dirs.push(scratch);
  const original = readFileSync(join(project, "scripts/workspace-lease.mjs"), "utf8");
  const anchor = 'const { spawn } = await import("node:child_process");';
  expect(original.split(anchor).length - 1).toBe(3);
  const instrumented = original.replaceAll(anchor, `
const { spawn: nativeSpawn } = await import("node:child_process");
const spawn = (...args) => {
  const child = nativeSpawn(...args);
  // A native signal may arrive before JavaScript returns from spawn. Keep
  // that real startup boundary open without replacing flock or its owner.
  if (args[0] === "flock") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  return child;
};`);
  const path = join(scratch, "workspace-lease.mjs");
  writeFileSync(path, instrumented);
  await cancelledWaiter("SIGTERM", pathToFileURL(path).href);
});

test("the real pinned container wrapper waits for host ownership of its mounted checkout", async () => {
  const root = fixture();
  for (const path of ["scripts", "packages/ui-kit", "node_modules/vitest"]) mkdirSync(join(root, path), { recursive: true });
  for (const name of ["visual.mjs", "workspace-lease.mjs"]) copyFileSync(join(project, "scripts", name), join(root, "scripts", name));
  writeFileSync(join(root, "node_modules/vitest/vitest.mjs"), 'import {writeFileSync} from "node:fs";writeFileSync("/repo/vitest-entered","native container acquired ownership\\n");\n');
  const owner = start(root, "write", "hold", "host");
  await entered(root, "host");
  const container = Bun.spawn(["docker", "run", "--rm", "--pull=never", "--network=none", "--ipc=host",
    "--user", `${process.getuid!()}:${process.getgid!()}`, "-v", `${root}:/repo`, "-w", "/repo",
    "mcr.microsoft.com/playwright:v1.63.0-noble", "node", "scripts/visual.mjs", "--inside", "--project=visual"],
  { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.push(container);
  const stdout = new Response(container.stdout).text();
  const [captured, observed] = container.stderr.tee();
  const stderr = new Response(captured).text(), reader = observed.getReader();
  let announced = "";
  try {
    while (!announced.includes("Acquiring exclusive workspace output access")) {
      const next = await reader.read();
      if (next.done) throw new Error(`Container did not attempt ownership: ${announced}`);
      announced += new TextDecoder().decode(next.value);
    }
  } finally { reader.releaseLock(); }
  await Bun.sleep(100);
  expect(existsSync(join(root, "vitest-entered"))).toBe(false);
  release(root, "host");
  expect(await owner.child.exited).toBe(0);
  expect(await container.exited, await stderr).toBe(0);
  await stdout;
  expect(readFileSync(join(root, "vitest-entered"), "utf8")).toBe("native container acquired ownership\n");
});

test("direct Bun test preserves its selector, timeout and offline preload while waiting", async () => {
  const root = fixture();
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "packages/core/tests"), { recursive: true });
  for (const name of ["test-network-preload.ts", "test-network-guard.ts", "test-network-child-preload.ts", "workspace-lease.mjs"]) {
    copyFileSync(join(project, "scripts", name), join(root, "scripts", name));
  }
  copyFileSync(join(project, "packages/core/tests/cli-harness.ts"), join(root, "packages/core/tests/cli-harness.ts"));
  writeFileSync(join(root, "bunfig.toml"), '[test]\npreload = ["./scripts/test-network-preload.ts"]\n');
  writeFileSync(join(root, "reader.test.ts"), `
import {test,expect} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
test("Odysseus importer",async()=>{
  const value=await import("./dist/index.js");expect(value.captain).toBe("Odysseus");
  writeFileSync("command-observed.json",JSON.stringify(readFileSync("/proc/self/cmdline","utf8").split("\\0").slice(1,-1)));
});
test("excluded importer",()=>{throw new Error("selector was lost");});
`);
  const owner = start(root, "write", "writer", "host"); await removed(root, "host");
  const args = ["test", "reader.test.ts", "--timeout", "30000", "-t", "Odysseus importer"];
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const [captured, observed] = child.stderr.tee();
  const stderr = new Response(captured).text(), reader = observed.getReader();
  let announced = "";
  try {
    while (!announced.includes("Acquiring exclusive workspace output access")) {
      const next = await reader.read();
      if (next.done) throw new Error(`Direct test did not attempt ownership: ${announced}`);
      announced += new TextDecoder().decode(next.value);
    }
  } finally { reader.releaseLock(); }
  expect(existsSync(join(root, "command-observed.json"))).toBe(false);
  release(root, "host"); expect(await owner.child.exited).toBe(0);
  expect(await child.exited, await stderr).toBe(0); await stdout;
  expect(JSON.parse(readFileSync(join(root, "command-observed.json"), "utf8"))).toEqual([
    "test", "--preload", join(project, "scripts/test-network-child-preload.ts"), ...args.slice(1),
  ]);
});

test("Bun run nested tests reuse live ancestor ownership even after their descriptor is closed", async () => {
  const root = fixture();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "odysseus-build-fixture", scripts: { test: "bun test borrower.test.ts --timeout 30000" } }));
  writeFileSync(join(root, "bunfig.toml"), `[test]\npreload = ${JSON.stringify([join(project, "scripts/test-network-preload.ts")])}\n`);
  writeFileSync(join(root, "borrower.test.ts"), `
import {test} from "bun:test";
import {fstatSync,closeSync} from "node:fs";
import {ensureWorkspaceLease} from ${JSON.stringify(helper)};
test("Odysseus borrows ancestor ownership",async()=>{
  const lease=JSON.parse(process.env.BRAIN_WORKSPACE_LEASE);
  try {const held=fstatSync(lease.fd);if(held.dev===lease.dev&&held.ino===lease.ino)closeSync(lease.fd);}catch{}
  const result=await ensureWorkspaceLease(${JSON.stringify(project)},"write");
  if(result!==undefined)process.exit(result);
  console.log("LIVE_ANCESTOR_REUSED");
});

`);
  const child = Bun.spawn([process.execPath, "run", "test"], { cwd: root, detached: true,
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });
  children.push(child);
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  try {
    const outcome = await Promise.race([child.exited, Bun.sleep(2000).then(() => "blocked")]);
    expect(outcome, "nested test must finish while its caller still owns output").toBe(0);
    expect((await stdout) + (await stderr)).toContain("LIVE_ANCESTOR_REUSED");
  } finally {
    if (child.exitCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* The child already exited. */ }
      await child.exited;
    }
  }
});

test("ownership propagation preserves synchronous captured stderr and explicitly ignored streams", async () => {
  const program = 'process.stdout.write("Odysseus");process.stderr.write("Athena");';
  const captured = Bun.spawnSync([node, "-e", program]);
  expect(captured.exitCode).toBe(0);
  expect(captured.stdout.toString()).toBe("Odysseus");
  expect(captured.stderr.toString()).toBe("Athena");
  // Observe the outer process's pipes: null must not become inherited stderr.
  const code = `const result=Bun.spawnSync(${JSON.stringify([node, "-e", program])},{stdout:null,stderr:null});process.exit(result.exitCode);`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(await stdout).toBe(""); expect(await stderr).toBe("");
});
