import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deadlineFactor, watchdogMs } from "../scripts/test-deadlines";
import { testCapMs } from "../scripts/test-determinism";

test("replaced-environment runtime fixtures work with an unwritable passwd home", async () => {
  const repo = resolve(import.meta.dir, ".."), scratch = join(repo, "tmp");
  // Direct scripts/test.ts launches need the manifest cap and both load-scaling paths.
  const factor = String(deadlineFactor()), cap = watchdogMs(testCapMs(repo));
  mkdirSync(scratch, { recursive: true });
  // Native probes replace /tmp. Keep the read-only passwd home visible
  // through those nested mounts so a fallback cannot recreate it writable.
  const root = mkdtempSync(join(scratch, "odysseus-passwd-home-"));
  const home = join(root, "readonly-home"), passwd = join(root, "passwd");
  mkdirSync(home);
  writeFileSync(passwd, `odysseus:x:${process.getuid!()}:${process.getgid!()}:Odysseus:${home}:/bin/sh\n`);
  const driver = join(root, "probe.ts");
  writeFileSync(driver, `
import {readFileSync} from "node:fs";
import {spawnSync} from "bun";
const home=${JSON.stringify(home)};
if(!readFileSync("/etc/passwd","utf8").includes(":"+home+":"))throw Error("PASSWD_HOME_NOT_INSTALLED");
const control=spawnSync(["/usr/bin/python3","-I","-S","-c",'import os,pwd; p=pwd.getpwuid(os.getuid()).pw_dir; assert p=='+JSON.stringify(home)+'; os.mkdir(p+"/must-refuse")'],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
if(control.exitCode===0||!control.stderr.toString().includes("Read-only file system"))throw Error("PASSWD_HOME_MUST_BE_UNWRITABLE "+control.stderr);
const cases=[
 {args:["tests/autonomous-runtime.test.ts","-t","does not persist"],count:2},
 {args:["packages/ui-backend-claude/tests/autonomous-prompt.test.ts"],count:1},
 {args:["tests/policy-write-boundary.test.ts","-t","autonomous: explicitly allowed raw writers"],count:2},
];
for(const {args,count} of cases){
 const child=Bun.spawn([process.execPath,${JSON.stringify(join(repo, "scripts/test.ts"))},"--timeout=${cap}","--preload",${JSON.stringify(join(repo, "scripts/test-deadline-preload.ts"))},...args],{cwd:${JSON.stringify(repo)},env:{PATH:process.env.PATH,BRAIN_TEST_DEADLINE_FACTOR:${JSON.stringify(factor)}},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 if(code!==0)throw Error("FIXTURE_PRIVATE_HOME_REQUIRED "+args[0]+"\\n"+out+"\\n"+err);
 if(!new RegExp("Ran "+count+" tests? across").test(err))throw Error("FIXTURE_HOME_CASES_MUST_EXECUTE "+args[0]+"\\n"+err);
}
console.log("PRIVATE_FIXTURE_HOMES_WITH_READONLY_PASSWD_HOME");
`);
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--ro-bind", passwd, "/etc/passwd",
      "--ro-bind", home, home, "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(repo, "scripts/test-network-child-preload.ts"), driver], {
      cwd: repo, env: { PATH: process.env.PATH!, BRAIN_TEST_DEADLINE_FACTOR: factor }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err || out).toBe(0);
    expect(out).toContain("PRIVATE_FIXTURE_HOMES_WITH_READONLY_PASSWD_HOME");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, watchdogMs(180_000));
