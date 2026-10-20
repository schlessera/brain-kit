import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumerProbe, invocationFixture } from "./helpers/test-invocation-fixture";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const value = invocationFixture(); roots.push(value.root); return value; }
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 10_000;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check(), label).toBe(true);
}
function stopOwnedGroup(pid: number) {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function start(root: string, args = ["owner.ts"]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, env: { ...process.env, ONLY: "ithaca" }, stdout: "pipe", stderr: "pipe" });
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const bytes of stream) output += new TextDecoder().decode(bytes); };
  const done = Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]).then(([code]) => ({ code, output }));
  return { child, done, output: () => output };
}

test("preparation waits for real delayed stdout and stderr EOF after builder exit", async () => {
  const { root, write } = fixture();
  const compiler = readFileSync(join(root, "node_modules/.bin/tsc"), "utf8");
  write("node_modules/.bin/tsc", compiler + `
Bun.spawn([process.execPath,"hold.ts"],{stdout:"inherit",stderr:"inherit"});process.exit(process.exitCode||0);
`);
  write("hold.ts", `import {existsSync,writeFileSync} from "node:fs";writeFileSync("tmp/eof-holder",String(process.pid));const end=Date.now()+10000;while(!existsSync("tmp/release-eof")&&Date.now()<end)await Bun.sleep(10);writeFileSync("tmp/eof-done","done");console.log("delayed stdout");console.error("delayed stderr");`);
  write("probe.ts", consumerProbe + `expect(readFileSync("tmp/eof-done","utf8"),"REAL_EOF_PRECEDES_AUTHORITY").toBe("done");expect(invocationBuild(root,["ithaca"])).toBeDefined();await hook();expect(consume()).toBe(1);console.log("TESTS_STARTED");`);
  const running = start(root);
  try {
    await until(() => running.output().includes('"event":"build-exit"'), "BUILDER_EXIT_OBSERVED");
    expect(running.output(), "NO_EARLY_AUTHORITY_AT_EXIT").not.toContain('"event":"build-attested"');
    expect(running.output()).not.toContain("TESTS_STARTED");
    writeFileSync(join(root, "tmp/release-eof"), "release");
    const result = await running.done; expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("delayed stdout"); expect(result.output).toContain("delayed stderr");
    for (const channel of ["stdout", "stderr"]) expect(result.output.indexOf(`"event":"${channel}-complete"`)).toBeLessThan(result.output.indexOf('"event":"build-attested"'));
  } finally { running.child.kill(); await running.done; }
});

test("cancellation during actual preparation prevents tests and cleans the owned compiler", async () => {
  const { root, write } = fixture();
  write("node_modules/.bin/tsc", `#!${process.execPath}\nimport {writeFileSync} from "node:fs";writeFileSync("tmp/compiler-pid",String(process.pid));await Bun.sleep(30000);process.exit(0);\n`);
  write("sentinel.test.ts", 'import {test} from "bun:test";test("must not start",()=>console.log("TESTS_STARTED"));');
  const running = start(root, ["run", "test", "--internal-full-preparation", "sentinel.test.ts"]);
  try {
    await until(() => existsSync(join(root, "tmp/compiler-pid")), "COMPILER_STARTED");
    const pid = Number(readFileSync(join(root, "tmp/compiler-pid"), "utf8"));
    running.child.kill("SIGTERM");
    const result = await running.done; expect(result.code, result.output).not.toBe(0);
    expect(result.output).not.toContain("TESTS_STARTED"); expect(result.output).not.toContain('"event":"build-attested"');
    await until(() => !existsSync(`/proc/${pid}`) || /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")), "OWNED_COMPILER_STOPPED");
    // The same checkout is admitted by a fresh writer after cancellation.
    const lock = Bun.spawn([process.execPath, "-e", 'import {ensureWorkspaceLease} from "./scripts/workspace-lease.mjs";const code=await ensureWorkspaceLease(process.cwd(),"write");if(code!==undefined)process.exit(code);console.log("NEW_WRITER_ADMITTED");'], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([lock.exited, new Response(lock.stdout).text(), new Response(lock.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain("NEW_WRITER_ADMITTED");
  } finally { running.child.kill(); await running.done; }
});

test("abrupt invocation owner death revokes receipt while an explicitly owned descendant survives", async () => {
  const { root, write } = fixture();
  write("survivor.ts", consumerProbe + `const end=Date.now()+10000;while(!require("fs").existsSync("tmp/owner-died")&&Date.now()<end)await Bun.sleep(10);expect(invocationBuild(root,["ithaca"]),"DEAD_OWNER_REVOKES_AUTHORITY").toBeUndefined();source(2);await hook();expect(consume(),"DEAD_OWNER_FALLBACK_REACHES_CONSUMER").toBe(2);writeFileSync("tmp/survivor-done","done");`);
  write("probe.ts", `import {spawn} from "node:child_process";import {writeFileSync,openSync} from "node:fs";
const out=openSync("tmp/survivor.log","w");const child=spawn(process.execPath,["survivor.ts"],{detached:true,stdio:["ignore",out,out],env:process.env});child.unref();writeFileSync("tmp/survivor-pid",String(child.pid));process.kill(JSON.parse(process.env.BRAIN_TEST_BUILD_AUTHORITY).ownerPid,"SIGKILL");await Bun.sleep(30000);`);
  const running = start(root); let survivor: number | undefined;
  try {
    await until(() => existsSync(join(root, "tmp/survivor-pid")), "SURVIVOR_STARTED");
    survivor = Number(readFileSync(join(root, "tmp/survivor-pid"), "utf8"));
    const result = await running.done; expect(result.code).not.toBe(0);
    writeFileSync(join(root, "tmp/owner-died"), "release");
    await until(() => existsSync(join(root, "tmp/survivor-done")), "SURVIVOR_ACTUAL_FALLBACK: " + (existsSync(join(root, "tmp/survivor.log")) ? readFileSync(join(root, "tmp/survivor.log"), "utf8") : ""));
    expect(readFileSync(join(root, "tmp/survivor-done"), "utf8")).toBe("done");
  } finally {
    running.child.kill(); await running.done;
    if (survivor) stopOwnedGroup(survivor);
  }
});

test("a real receipt open failure removes only owned scratch and leaves hooks rebuilding", async () => {
  const { root, write } = fixture();
  write("receipt-fault.ts", `import fs from "node:fs";import {mock} from "bun:test";
const open=fs.openSync;let injected=false;
mock.module("node:fs",()=>({...fs,openSync:(path,flags,...args)=>{
 if(!injected&&typeof path==="string"&&path.includes("/brain-test-invocation-")&&path.endsWith("/receipt")&&!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR))){
  injected=true;fs.writeFileSync(${JSON.stringify(join(root, "scratch-path"))},path);fs.chmodSync(path,0);
  try{return open(path,flags,...args)}catch(error){fs.writeFileSync(${JSON.stringify(join(root, "scratch-error"))},error.code);throw error}
 }
 return open(path,flags,...args);
}}));`);
  write("probe.ts", consumerProbe + `expect(invocationBuild(root,["ithaca"])).toBeUndefined();source(2);await hook();expect(consume(),"RECEIPT_FAILURE_FALLBACK_REACHES_CONSUMER").toBe(2);`);
  const running = start(root, ["--preload", join(root, "receipt-fault.ts"), "owner.ts"]);
  try {
    const result = await running.done;
    expect(existsSync(join(root, "scratch-error")), result.output).toBe(true);
    expect(readFileSync(join(root, "scratch-error"), "utf8"), "REAL_KERNEL_RECEIPT_OPEN_ERROR").toBe("EACCES");
    const scratch = readFileSync(join(root, "scratch-path"), "utf8");
    expect(result.code, "RECEIPT_FAILURE_FALLBACK_REACHES_CONSUMER: " + result.output).toBe(0);
    expect(existsSync(scratch), "OWNED_FAILED_RECEIPT_REMOVED").toBe(false);
    expect(existsSync(join(scratch, "..")), "OWNED_EMPTY_SCRATCH_REMOVED").toBe(false);
  } finally {
    running.child.kill(); await running.done;
    if (existsSync(join(root, "scratch-path"))) rmSync(join(readFileSync(join(root, "scratch-path"), "utf8"), ".."), { recursive: true, force: true });
  }
});

for (const damage of ["unrelated-entry", "replaced-receipt"] as const) test(`receipt cleanup retains ${damage} and fails before tests`, async () => {
  const { root, write } = fixture();
  write("receipt-fault.ts", `import fs from "node:fs";import {mock} from "bun:test";
const open=fs.openSync;let injected=false;
mock.module("node:fs",()=>({...fs,openSync:(path,flags,...args)=>{
 if(!injected&&typeof path==="string"&&path.includes("/brain-test-invocation-")&&path.endsWith("/receipt")&&!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR))){
  injected=true;fs.writeFileSync(${JSON.stringify(join(root, "scratch-path"))},path);
  ${damage === "unrelated-entry" ? 'fs.writeFileSync(path+".unrelated","Penelope retains this entry");fs.chmodSync(path,0);' : 'fs.renameSync(path,path+".original");fs.writeFileSync(path,"Penelope retains this replacement");'}
 }
 return open(path,flags,...args);
}}));`);
  write("probe.ts", 'console.log("TESTS_STARTED");');
  const running = start(root, ["--preload", join(root, "receipt-fault.ts"), "owner.ts"]);
  try {
    const result = await running.done;
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(damage === "unrelated-entry" ? "ENOTEMPTY" : "Replaced invocation receipt; retained scratch");
    expect(result.output).not.toContain("TESTS_STARTED");
    expect(result.output).not.toContain('"event":"build-attested"');
    const path = readFileSync(join(root, "scratch-path"), "utf8");
    if (damage === "unrelated-entry") {
      expect(existsSync(path), "OWNED_RECEIPT_REMOVED_DESPITE_UNRELATED_ENTRY").toBe(false);
      expect(readFileSync(path + ".unrelated", "utf8"), "UNRELATED_ENTRY_RETAINED").toBe("Penelope retains this entry");
    } else {
      expect(readFileSync(path, "utf8"), "REPLACEMENT_INODE_RETAINED").toBe("Penelope retains this replacement");
    }
  } finally {
    running.child.kill(); await running.done;
    // These injected entries belong to this control, never production cleanup.
    if (existsSync(join(root, "scratch-path"))) rmSync(join(readFileSync(join(root, "scratch-path"), "utf8"), ".."), { recursive: true, force: true });
  }
});

test("cancelling a nested preparation stops its compiler while the outer invocation stays live", async () => {
  const { root, write } = fixture();
  write("nested.test.ts", 'import {test} from "bun:test";test("must not start",()=>console.log("NESTED_TESTS_STARTED"));');
  write("probe.ts", consumerProbe + `
writeFileSync("node_modules/.bin/tsc",'#!'+process.execPath+'\\nimport {writeFileSync} from "node:fs";writeFileSync("tmp/nested-compiler",String(process.pid));await Bun.sleep(30000);');
const child=Bun.spawn([process.execPath,"run","test","--internal-full-preparation","nested.test.ts"],{stdout:"pipe",stderr:"pipe"});
const output=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
const end=Date.now()+10000;while(!require("fs").existsSync("tmp/nested-compiler")&&Date.now()<end)await Bun.sleep(10);
const compiler=Number(readFileSync("tmp/nested-compiler","utf8"));child.kill("SIGTERM");
const stopped=Date.now()+2000;const live=()=>{try{return !/\\) [ZX] /.test(readFileSync('/proc/'+compiler+'/stat','utf8'))}catch{return false}};while(live()&&Date.now()<stopped)await Bun.sleep(10);
expect(live(),"NESTED_CANCEL_STOPS_COMPILER_BEFORE_OUTER_EXIT").toBe(false);expect(await child.exited).not.toBe(0);
expect((await output).join('')).not.toContain("NESTED_TESTS_STARTED");`);
  const running = start(root);
  try { const result = await running.done; expect(result.code, result.output).toBe(0); }
  finally { running.child.kill(); await running.done; }
});

for (const entry of ["wrapper", "direct"] as const) test(`${entry} watch reruns rebuild instead of borrowing live outer authority`, async () => {
  const { root, write } = fixture();
  write("expected", "1");
  const watched = consumerProbe + `import {test} from "bun:test";test("watch consumer",async()=>{expect(invocationBuild(root,["ithaca"]),"WATCH_NEVER_BORROWS_AUTHORITY").toBeUndefined();await hook();const marker=consume();expect(marker,"WATCH_RERUN_FRESH_CONSUMER").toBe(Number(readFileSync("expected","utf8")));console.log("WATCH_CONSUMER",marker);});`;
  write("watched.test.ts", watched);
  const args = entry === "wrapper" ? ["run", "test", "--watch", "watched.test.ts"] : ["test", "--watch", "--preload", join(root, "scripts/test-network-preload.ts"), "watched.test.ts"];
  write("probe.ts", `import {existsSync} from "node:fs";
const child=Bun.spawn([process.execPath,...${JSON.stringify(args)}],{stdout:"inherit",stderr:"inherit"});const end=Date.now()+15000;while(!existsSync("tmp/stop-watch")&&Date.now()<end)await Bun.sleep(10);child.kill("SIGTERM");await child.exited;`);
  const running = start(root);
  try {
    await until(() => running.output().includes("WATCH_CONSUMER 1"), "FIRST_WATCH_CONSUMER: " + running.output());
    write("expected", "2"); write("packages/ithaca/src/index.ts", "export const cargo = 2;\n");
    write("watched.test.ts", watched + "\n// Odysseus prepares another voyage.\n");
    await until(() => running.output().includes("WATCH_CONSUMER 2"), "SECOND_WATCH_CONSUMER: " + running.output());
    write("tmp/stop-watch", "stop");
    const result = await running.done; expect(result.code, result.output).toBe(0); expect(result.output).not.toContain("(fail)");
  } finally { write("tmp/stop-watch", "stop"); running.child.kill(); await running.done; }
});
