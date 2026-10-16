/** Small real Git/Bun workspaces for the queue's filesystem and kernel boundaries. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function unitWorkerFixture() {
  const source = resolve(import.meta.dir, "../..");
  const root = mkdtempSync(join(dirname(source), ".odysseus-unit-workers-"));
  mkdirSync(join(root, "tmp"));
  const lease = join(source, "scripts/workspace-lease.mjs");
  const guard = join(source, "scripts/test-network-child-preload.ts");
  const budget = join(source, "packages/ui-sdk/src/server/maintenance-temp-budget.ts");
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  write("scripts/unit-worker-entry.sh", readFileSync(join(source, "scripts/unit-worker-entry.sh"), "utf8"));
  write(".gitignore", "node_modules/\ntmp/\ndist/\n");
  write("package.json", JSON.stringify({ name: "odysseus-unit-fixture", type: "module", scripts: { build: "bun scripts/build.ts", test: "bun scripts/test.ts" } }));
  write("packages/raft/README.md", "Odysseus builds the raft.\n");
  // This byte-owned stand-in tests dependency copying, not a compiler version.
  write("node_modules/typescript/package.json", '{"name":"odysseus-dependency-fixture"}\n');
  write("scripts/build.ts", `import {mkdirSync,writeFileSync} from "node:fs";
import {ensureWorkspaceLease} from ${JSON.stringify(lease)};
const code=await ensureWorkspaceLease(process.cwd(),"write");if(code!==undefined)process.exit(code);
mkdirSync("dist",{recursive:true});writeFileSync("dist/ready.txt","Odysseus builds the raft.");\n`);
  write("scripts/test.ts", `import {ensureWorkspaceLease,inheritWorkspaceLease} from ${JSON.stringify(lease)};
const code=await ensureWorkspaceLease(process.cwd(),"write");if(code!==undefined)process.exit(code);
const child=Bun.spawn([process.execPath,"test","--preload",${JSON.stringify(guard)},...process.argv.slice(2)],inheritWorkspaceLease({stdio:["inherit","inherit","inherit"]}));
process.exit(await child.exited);\n`);
  const files = ["odysseus", "penelope"].map(name => `tests/${name}.test.ts`);
  for (const [index, file] of files.entries()) write(file, `import {expect,test} from "bun:test";
import {existsSync,mkdirSync,readFileSync,statSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {reserveMaintenanceTemp} from ${JSON.stringify(budget)};
test("${index === 0 ? "Odysseus" : "Penelope"} owns build, lease and maintenance admission",async()=>{
  expect(process.umask(),"CALLER_UMASK_PRESERVED").toBe(${process.umask()});
  expect(statSync(dirname(process.cwd())).mode&0o777,"PRIVATE_UNIT_CONTAINER_MODE").toBe(0o700);
  expect(statSync("tmp/maintenance-ledger").mode&0o777,"PRIVATE_UNIT_LEDGER_MODE").toBe(0o700);
  const native=Bun.spawnSync(["bwrap","--unshare-net","--ro-bind","/","/","--tmpfs","/tmp","--proc","/proc","--dev","/dev",process.execPath,"-e",'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)',join(process.cwd(),"package.json")],{stdout:"pipe",stderr:"pipe"});
  expect(native.exitCode,"PRIVATE_NATIVE_SOURCE_VISIBLE: "+new TextDecoder().decode(native.stderr)).toBe(0);
  expect(new TextDecoder().decode(native.stdout).trim()).toBe("odysseus-unit-fixture");
  const status=readFileSync("/proc/self/status","utf8");
  for(const key of ["CapEff","CapInh","CapAmb"])expect(BigInt("0x"+new RegExp(key+":\\\\s+([0-9a-f]+)").exec(status)![1]),"UNIT_SETUP_CAPABILITIES_DROPPED").toBe(0n);
  expect(existsSync("dist/ready.txt"),"PRIVATE_UNIT_BUILD_READY").toBe(true);
  expect(readFileSync("dist/ready.txt","utf8")).toBe("Odysseus builds the raft.");
  const lease=JSON.parse(process.env.BRAIN_WORKSPACE_LEASE!);
  expect(lease.ino,"PRIVATE_UNIT_OUTPUT_LEASE").toBe(statSync("tmp/workspace-operation/output.lock").ino);
  const git=Bun.spawnSync(["git","rev-parse","--path-format=absolute","--git-common-dir"],{stdout:"pipe",stderr:"pipe"});expect(git.exitCode).toBe(0);
  const parent=dirname(new TextDecoder().decode(git.stdout).trim()),shared=join(parent,"tmp/shared");mkdirSync(shared,{recursive:true});
  expect(existsSync(join(parent,"dist/ready.txt")),"PARENT_BUILD_OUTPUT_NOT_SHARED").toBe(false);
  const limits={allowanceBytes:268435456,budgetBytes:268435456};
  const reservation=reserveMaintenanceTemp(limits);
  try {
    const admission={uid:process.getuid!(),pid:process.pid,directory:reservation.directory,mount:readFileSync("/proc/self/mountinfo","utf8"),inode:statSync(reservation.directory).ino};
    writeFileSync(join(shared,"${index}.admitted"),JSON.stringify(admission));
    console.log("PRIVATE_LEDGER_ADMISSION",JSON.stringify({...admission,mount:undefined}));
    const deadline=Date.now()+5000;while(!existsSync(join(shared,"${1-index}.admitted"))&&Date.now()<deadline)await Bun.sleep(5);
    expect(existsSync(join(shared,"${1-index}.admitted")),"BOTH_PRIVATE_LEDGER_WORKERS_ADMITTED").toBe(true);
    expect(()=>reserveMaintenanceTemp(limits),"SAME_WORKER_FULL_BUDGET_STAYS_BUSY").toThrow("Maintenance temporary storage is busy");
    const program='import {reserveMaintenanceTemp} from '+${JSON.stringify(JSON.stringify(budget))}+';let held;try{held=reserveMaintenanceTemp({allowanceBytes:268435456,budgetBytes:268435456});console.log("admitted")}catch(error){console.log(error.message.includes("Maintenance temporary storage is busy")?"busy":"unexpected")}finally{held?.release()}';
    const check=async()=>{const child=Bun.spawn([process.execPath,"-e",program],{stdout:"pipe",stderr:"pipe"});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,err).toBe(0);return out.trim()};
    expect(await check(),"SAME_WORKER_CHILD_SHARES_FULL_BUDGET").toBe("busy");
    reservation.release();expect(await check(),"SAME_WORKER_CHILD_ADMITTED_AFTER_RELEASE").toBe("admitted");
  } finally {reservation.release()}
});\n`);
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T00:00:00Z" } });
    if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
  };
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "--quiet", "-m", "Build the raft fixture");
  return { root, files };
}
