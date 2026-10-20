import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { consumerProbe, invocationFixture } from "./helpers/test-invocation-fixture";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const value = invocationFixture(); roots.push(value.root); return value; }
async function run(root: string, args = ["owner.ts"], env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: out + err };
}
function receipts(root: string) { return readdirSync(join(root, "tmp")).filter(file => /^build-.*-probe.json$/.test(file)).map(file => JSON.parse(readFileSync(join(root, "tmp", file), "utf8"))); }

test("multiple real hooks consume one completed invocation build", async () => {
  const { root, write } = fixture();
  write("probe.ts", consumerProbe + `expect(invocationBuild(root,["ithaca"]),"LIVE_BUILD_AUTHORITY").toBeDefined();await hook();source(2);await hook();expect(consume(),"MIDRUN_EDIT_WAITS_FOR_NEXT_INVOCATION").toBe(1);`);
  const result = await run(root); expect(result.code, result.output).toBe(0);
  expect(receipts(root), "ONE_ACTUAL_COMPILER_SET").toHaveLength(1);
  expect(result.output.match(/"disposition":"attested"/g)).toHaveLength(4);
  write("probe.ts", consumerProbe + `await hook();expect(consume(),"NEXT_INVOCATION_REACHES_CONSUMER").toBe(2);`);
  const next = await run(root); expect(next.code, next.output).toBe(0); expect(receipts(root)).toHaveLength(2);
});

for (const [name, damage] of Object.entries({
  absent: 'delete process.env.BRAIN_TEST_BUILD_AUTHORITY;',
  malformed: 'process.env.BRAIN_TEST_BUILD_AUTHORITY="{";',
  nonce: 'process.env.BRAIN_TEST_INVOCATION_NONCE="00000000-0000-0000-0000-000000000000";',
  "reused-owner-pid": 'const loc=JSON.parse(process.env.BRAIN_TEST_BUILD_AUTHORITY);loc.ownerStart="0";process.env.BRAIN_TEST_BUILD_AUTHORITY=JSON.stringify(loc);',
  "reused-owner-fd": 'const loc=JSON.parse(process.env.BRAIN_TEST_BUILD_AUTHORITY);loc.fd=3;process.env.BRAIN_TEST_BUILD_AUTHORITY=JSON.stringify(loc);',
  "wrong-root-inode": 'replaceRecord(r=>r.root.ino++);',
  "mismatched-lease": 'replaceRecord(r=>r.lease.ownerStart="0");',
  "failed-receipt": 'replaceRecord(r=>r.build.success=false);',
  "interrupted-receipt": 'replaceRecord(r=>r.build.state="running");',
  "missing-package": 'replaceRecord(r=>r.build.packages=[]);',
  "missing-compiler": 'replaceRecord(r=>r.build.packages[0].children=[]);',
  "wrong-schema": 'replaceRecord(r=>r.version=2);',
  "replaced-receipt": 'const loc=JSON.parse(process.env.BRAIN_TEST_BUILD_AUTHORITY);writeFileSync("/proc/"+loc.ownerPid+"/fd/"+loc.fd,"{}");',
})) test(`actual helper rebuilds after ${name} authority`, async () => {
  const { root, write } = fixture();
  write("probe.ts", consumerProbe + `expect(invocationBuild(root,["ithaca"])).toBeDefined();source(2);${damage}await hook();expect(consume(),"INVALID_AUTHORITY_REBUILDS_CONSUMER").toBe(2);`);
  const result = await run(root); expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(2);
});

test("a readable lease descriptor without its own held flock cannot attest a build", async () => {
  const { root, write } = fixture();
  write("probe.ts", consumerProbe + `
const lease=JSON.parse(process.env.BRAIN_WORKSPACE_LEASE),fd=openSync("tmp/workspace-operation/output.lock","r");
const fields=readFileSync("/proc/self/stat","utf8").split(") ")[1].split(" ");
const marker={...lease,fd,ownerFd:fd,ownerPid:process.pid,ownerStart:fields[19]};
expect(readFileSync("/proc/self/fdinfo/"+fd,"utf8")).not.toContain("FLOCK");
process.env.BRAIN_WORKSPACE_LEASE=JSON.stringify(marker);
replaceRecord(r=>r.lease={...r.lease,ownerFd:fd,ownerPid:process.pid,ownerStart:fields[19]});
try{source(2);await hook();expect(consume(),"UNHELD_DESCRIPTOR_CANNOT_SUPPRESS_COMPILER").toBe(2)}finally{closeSync(fd)}
`);
  const result = await run(root); expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(2);
});

test("valid smaller closure cannot authorize another package", async () => {
  const { root, write } = fixture();
  write("probe.ts", consumerProbe + `expect(invocationBuild(root,["troy"])).toBeDefined();await hook();expect(consume(),"CLOSURE_SUBSET_REBUILDS_CONSUMER").toBe(1);`);
  const result = await run(root, ["owner.ts"], { ONLY: "troy" }); expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(2);
});

test("a live ancestor's other checkout receipt never suppresses the actual consumer build", async () => {
  const first = fixture(), second = fixture();
  second.write("packages/ithaca/dist/index.js", "export const cargo=1;\n");
  second.write("probe.ts", consumerProbe + `source(2);await hook();expect(consume(),"CROSS_CHECKOUT_BUILD_REACHES_CONSUMER").toBe(2);`);
  first.write("probe.ts", `const child=Bun.spawn([process.execPath,${JSON.stringify(join(second.root, "probe.ts"))}],{cwd:${JSON.stringify(second.root)},stdout:"inherit",stderr:"inherit"});process.exitCode=await child.exited;`);
  const result = await run(first.root); expect(result.code, result.output).toBe(0); expect(receipts(second.root)).toHaveLength(1);
});

test("normal nested wrapper creates a new invocation beneath the same live lease", async () => {
  const { root, write } = fixture();
  write("probe.ts", consumerProbe + `source(2);const child=Bun.spawn([process.execPath,"run","test","--internal-full-preparation","nested.test.ts"],{stdout:"inherit",stderr:"inherit",env:{...process.env,PREVIOUS_NONCE:process.env.BRAIN_TEST_INVOCATION_NONCE,PREVIOUS_AUTHORITY:process.env.BRAIN_TEST_BUILD_AUTHORITY}});expect(await child.exited,"NESTED_WRAPPER").toBe(0);`);
  write("nested.test.ts", consumerProbe + `import {test} from "bun:test";test("new invocation",async()=>{expect(process.env.BRAIN_TEST_INVOCATION_NONCE,"NEW_INVOCATION_SAME_LEASE").not.toBe(process.env.PREVIOUS_NONCE);expect(consume()).toBe(2);source(3);process.env.BRAIN_TEST_BUILD_AUTHORITY=process.env.PREVIOUS_AUTHORITY;await hook();expect(consume(),"REPLAYED_INVOCATION_REBUILDS_CONSUMER").toBe(3);});`);
  const result = await run(root); expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(3);
});

test("legacy bypass flags without authority still compile", async () => {
  const { root, write } = fixture();
  write("packages/ithaca/dist/index.js", "export const cargo=0;\n");
  write("probe.ts", consumerProbe + `await hook();expect(consume(),"LEGACY_FLAGS_DO_NOT_SKIP_BUILD").toBe(1);`);
  const result = await run(root, ["probe.ts"], { BRAIN_JOURNAL_DEPENDENCIES_BUILT: "1", BRAIN_ARTIFACT_DEPENDENCIES_BUILT: "1", BRAIN_AUTH_FIXTURE_BUILT: "1" });
  expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(1);
});

test("actual prebuild compiler failure prevents test execution without retry", async () => {
  const { root, write } = fixture();
  write("packages/ithaca/src/index.ts", "export const cargo: string = 1;\n");
  write("sentinel.test.ts", 'import {test} from "bun:test";test("must not start",()=>console.log("TESTS_STARTED"));');
  const result = await run(root, ["run", "test", "--internal-full-preparation", "sentinel.test.ts"]);
  expect(result.code, result.output).not.toBe(0); expect(result.output).not.toContain("TESTS_STARTED"); expect(receipts(root)).toHaveLength(1);
  expect(receipts(root)[0].success).toBe(false);
});

for (const damage of ["missing", "malformed", "aliased", "wrong-builder-pid", "wrong-build-id", "wrong-closure"] as const) test(`successful preparation with ${damage} diagnostics leaves real hooks rebuilding`, async () => {
  const { root, write } = fixture();
  const path = join(root, "scripts/build.ts"), original = readFileSync(path, "utf8");
  write("scripts/build.ts", original + `
if(process.env.BRAIN_TEST_BUILD_ID){const fs=await import("node:fs");const file="tmp/build-"+process.pid+"-"+process.env.BRAIN_TEST_BUILD_ID+"-probe.json";
${damage === "missing" ? 'fs.unlinkSync(file);' : damage === "malformed" ? 'fs.writeFileSync(file,"{");' : damage === "aliased" ? 'fs.renameSync(file,file+".saved");fs.symlinkSync(file.split("/").pop()+".saved",file);' :
`const receipt=JSON.parse(fs.readFileSync(file,"utf8"));${damage === "wrong-builder-pid" ? "receipt.pid++;" : damage === "wrong-build-id" ? 'receipt.id="00000000-0000-0000-0000-000000000000";' : "receipt.packages.pop();"}fs.writeFileSync(file,JSON.stringify(receipt));`}}
`);
  // The hook is a different real builder and still runs even when both of its
  // best-effort diagnostics are damaged too. Exit/output, not probe presence,
  // prove actual compilation and the changed emitted consumer.
  write("probe.ts", consumerProbe + `expect(invocationBuild(root,["ithaca"])).toBeUndefined();source(2);await hook();expect(consume(),"DIAGNOSTIC_FAILURE_REBUILDS_CONSUMER").toBe(2);`);
  const result = await run(root); expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('"event":"build-unattested"'); expect(result.output).toContain('"disposition":"built"');
});

test("read-mode lease cannot reuse authority or delete existing output", async () => {
  const { root, write } = fixture();
  write("probe.ts", consumerProbe + `source(2);const lease=JSON.parse(process.env.BRAIN_WORKSPACE_LEASE);lease.mode="read";process.env.BRAIN_WORKSPACE_LEASE=JSON.stringify(lease);expect(invocationBuild(root,["ithaca"])).toBeUndefined();await expect(hook()).rejects.toThrow("Read-only verification cannot rebuild");expect(consume(),"READ_LEASE_PRESERVES_OUTPUT").toBe(1);`);
  const result = await run(root); expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(1);
});

test("ordinary explicit builders compile even with valid invocation authority", async () => {
  const { root, write } = fixture();
  write("probe.ts", consumerProbe + `expect(invocationBuild(root,["ithaca"])).toBeDefined();source(2);const child=Bun.spawn([process.execPath,"scripts/build.ts","--for","ithaca"],{stdout:"inherit",stderr:"inherit"});expect(await child.exited).toBe(0);expect(consume(),"EXPLICIT_BUILD_STILL_COMPILES").toBe(2);`);
  const result = await run(root); expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(2);
});

test("fresh standalone invocations consume effective config alias and installed compiler changes", async () => {
  const { root, write } = fixture();
  const { renameSync, symlinkSync, writeFileSync } = await import("node:fs");
  renameSync(join(root, "tsconfig.json"), join(root, "effective.json")); symlinkSync("effective.json", join(root, "tsconfig.json"));
  write("consumer.test.ts", consumerProbe + `import {test} from "bun:test";test("fresh consumer",async()=>{await hook();expect(consume(),"STANDALONE_COMPILER_CHANGE_REACHES_CONSUMER").toBe(Number(process.env.EXPECTED));expect(readFileSync(join(root,"packages/ithaca/dist/index.js"),"utf8").includes("?."),"STANDALONE_ALIAS_REACHES_OUTPUT").toBe(process.env.MODERN==="1");});`);
  const args = ["run", "test", "--internal-full-preparation", "consumer.test.ts"];
  let result = await run(root, args, { EXPECTED: "1" }); expect(result.code, result.output).toBe(0);
  write("effective.json", readFileSync(join(root, "effective.json"), "utf8").replace("ES2019", "ES2022"));
  const compiler = join(root, "node_modules/typescript/lib/_tsc.js"), original = readFileSync(compiler, "utf8");
  const anchor = "function emitNumericOrBigIntLiteral(node) {"; expect(original.split(anchor)).toHaveLength(2);
  writeFileSync(compiler, original.replace(anchor, anchor + '\n    if (node.text === "1") { writeStringLiteral("2"); return; }'));
  result = await run(root, args, { EXPECTED: "2", MODERN: "1" }); expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(2);
});

test("replacing a checkout at the same pathname revokes the live build receipt", async () => {
  const { root, write } = fixture(); roots.push(`${root}.previous`);
  write("probe.ts", consumerProbe + `expect(invocationBuild(root,["ithaca"])).toBeDefined();renameSync(root,root+".previous");cpSync(root+".previous",root,{recursive:true});source(2);await hook();expect(consume(),"REPLACED_CHECKOUT_REBUILDS_CONSUMER").toBe(2);`);
  const result = await run(root); expect(result.code, result.output).toBe(0); expect(receipts(root)).toHaveLength(2);
});
