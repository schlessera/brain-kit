/** Real compiler/output/Node consumers in private, byte-owned checkouts. */
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const source = resolve(import.meta.dir, "../..");
export function invocationFixture(parent = tmpdir()) {
  const root = mkdtempSync(join(parent, "odysseus-test-invocation-"));
  function write(path: string, bytes: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
  write("package.json", JSON.stringify({ name: "odysseus-invocation", private: true, type: "module", scripts: { test: "bun scripts/test.ts --timeout 30000" } }));
  write("bun.lock", "{}\n");
  write(".gitignore", "node_modules/\npackages/*/dist/\ntmp/\n");
  write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2019", module: "ESNext", moduleResolution: "Bundler", types: [], skipLibCheck: true } }));
  for (const file of ["build.ts", "build-execution.ts", "build-receipt.ts", "build-repeat-observation.ts", "bin-modes.ts", "publishable-packages.ts", "workspace-lease.mjs", "test.ts", "test-invocation.ts", "test-invocation-child.ts", "runtime-test-builds.ts", "test-network-preload.ts", "test-network-guard.ts", "test-network-child-preload.ts", "unit-worker-entry.sh"]) {
    write(`scripts/${file}`, readFileSync(join(source, "scripts", file), "utf8"));
  }
  for (const file of ["packages/core/tests/cli-harness.ts", "packages/ui-react/tests/fixtures/runtime-package-build.ts", "packages/ui-react/tests/fixtures/runtime-hook-phases.ts"]) write(file, readFileSync(join(source, file), "utf8"));
  cpSync(join(source, "node_modules/typescript"), join(root, "node_modules/typescript"), { recursive: true });
  write("node_modules/.bin/tsc", `#!${process.execPath}\nconst child=Bun.spawn([process.execPath,new URL("../typescript/bin/tsc",import.meta.url).pathname,...process.argv.slice(2)],{stdout:"inherit",stderr:"inherit"});process.exitCode=await child.exited;\n`);
  chmodSync(join(root, "node_modules/.bin/tsc"), 0o755);
  for (const name of ["ithaca", "troy"]) {
    write(`packages/${name}/package.json`, JSON.stringify({ name: `@odysseus/${name}`, version: "1.0.0", type: "module" }));
    write(`packages/${name}/src/index.ts`, 'export const cargo = 1; export const port = (value?: { name?: string }) => value?.name ?? "Ithaca";\n');
    write(`packages/${name}/tsconfig.build.json`, JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { outDir: "dist", rootDir: "src", declaration: true }, include: ["src"] }));
  }
  // The production coordinator with an actual child, and continuous real flock.
  write("owner.ts", `import {ensureWorkspaceLease,inheritWorkspaceLease} from "./scripts/workspace-lease.mjs";
import {clearInvocation,prepareInvocation} from "./scripts/test-invocation";
const code=await ensureWorkspaceLease(import.meta.dir,"write");if(code!==undefined)process.exit(code);
clearInvocation();let active;let cancelled=false;
for(const signal of ["SIGINT","SIGTERM","SIGHUP"])process.on(signal,()=>{cancelled=true;active?.stop ? active.stop(signal) : active?.kill(signal)});
const preparation=await prepareInvocation(import.meta.dir,(process.env.ONLY||"ithaca,troy").split(","),child=>{active=child});
try { if(preparation.code||cancelled)process.exitCode=preparation.code||1;else {
active=Bun.spawn([process.execPath,"probe.ts"],inheritWorkspaceLease({stdio:["inherit","inherit","inherit"]}));process.exitCode=await active.exited;
}}finally{preparation.dispose()}
`);
  return { root, write };
}

export const consumerProbe = `import {expect} from "bun:test";
import {readFileSync,writeFileSync,openSync,closeSync,renameSync,mkdirSync,cpSync,rmSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {runtimePackageBuild} from "./packages/ui-react/tests/fixtures/runtime-package-build";
import {runtimeHookPhases} from "./packages/ui-react/tests/fixtures/runtime-hook-phases";
import {invocationBuild} from "./scripts/test-invocation";
const root=import.meta.dir;
const hook=()=>runtimePackageBuild(root,["ithaca"],runtimeHookPhases("odysseus"));
const source=(marker)=>writeFileSync(join(root,"packages/ithaca/src/index.ts"),"export const cargo = "+marker+";\\n");
const consume=()=>{const child=Bun.spawnSync(["node","--input-type=module","-e",'import {cargo} from '+JSON.stringify(join(root,"packages/ithaca/dist/index.js"))+';console.log(cargo)'],{stdout:"pipe",stderr:"pipe"});expect(child.exitCode,new TextDecoder().decode(child.stderr)).toBe(0);return Number(new TextDecoder().decode(child.stdout).trim());};
const replaceRecord=(edit)=>{const locator=JSON.parse(process.env.BRAIN_TEST_BUILD_AUTHORITY);const path='/proc/'+locator.ownerPid+'/fd/'+locator.fd;const record=JSON.parse(readFileSync(path,'utf8'));edit(record);const bytes=JSON.stringify(record);const fd=openSync(path,'w');try{writeFileSync(fd,bytes)}finally{closeSync(fd)}locator.sha256=createHash('sha256').update(bytes).digest('hex');process.env.BRAIN_TEST_BUILD_AUTHORITY=JSON.stringify(locator);};
`;
