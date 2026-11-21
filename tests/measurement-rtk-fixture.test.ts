/** Plan and harmless re-entry only: no namespace or installed native runtime executes. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT=join(import.meta.dir,"..");
for(const mode of ["hosted","local","self-hosted"] as const) test(`cleared-env RTK re-entry preserves only the outer ${mode} qualification`,async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-rtk-reentry-"));
 try {
  const planFile=join(scratch,"plan.json"),parent=join(scratch,"parent.ts"),inner=join(scratch,"inner.ts");
  writeFileSync(parent,`import {writeFileSync} from "node:fs";
    const {enterMeasurementRtkView}=await import(${JSON.stringify(join(ROOT,"scripts/measurement-rtk-fixture.ts"))});
    ${mode==="hosted"?'delete process.env.GITHUB_ACTIONS;delete process.env.RUNNER_ENVIRONMENT;':'process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";'}
    Bun.spawnSync=(()=>({exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}));
    Bun.spawn=((argv,options)=>{writeFileSync(${JSON.stringify(planFile)},JSON.stringify({argv,env:options.env}));return {exited:Promise.resolve(0)};});
    await enterMeasurementRtkView();`);
  const child=Bun.spawn([process.execPath,parent],{env:{PATH:"/usr/bin:/bin",HOME:scratch,GITHUB_ACTIONS:mode==="local"?"false":"true",RUNNER_ENVIRONMENT:mode==="hosted"?"github-hosted":mode},stdout:"pipe",stderr:"pipe"});
  const [code,errors]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect(code,errors).toBe(0);
  const plan=JSON.parse(readFileSync(planFile,"utf8")) as {argv:string[];env:Record<string,string>};
  expect(plan.env).toEqual({});
  let env:Record<string,string|undefined>={};
  for(let i=0;i<plan.argv.length;i++) {
    if(plan.argv[i]==="--clearenv")env={};
    else if(plan.argv[i]==="--setenv"){env[plan.argv[i+1]!]=plan.argv[i+2]!;i+=2;}
  }
  expect(env.GITHUB_ACTIONS).toBe(mode==="hosted"?"true":undefined);
  expect(env.RUNNER_ENVIRONMENT).toBe(mode==="hosted"?"github-hosted":undefined);
  // Explicit false values prevent the test harness's own CI propagation from
  // promoting this deliberately local/self-hosted synthetic inner process.
  env.GITHUB_ACTIONS??="false";env.RUNNER_ENVIRONMENT??="local";
  writeFileSync(inner,`import {nativeClaudeBoundary} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};
    Bun.spawnSync=((argv)=>{if(argv[0]!=="bwrap")throw Error("unexpected qualification command");console.error("NAMESPACE_QUALIFIER_REACHED");return {exitCode:1,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};});
    try{nativeClaudeBoundary("/usr/bin/true",[],{});}catch{}process.exit(0);`);
  const reentry=Bun.spawn([process.execPath,inner],{env,stdout:"pipe",stderr:"pipe"});
  const [status,receipt]=await Promise.all([reentry.exited,new Response(reentry.stderr).text()]);
  expect(status).not.toBe(0);expect(receipt).toContain('"nativeLaunched":false');
  if(mode==="hosted") {
    expect(receipt).toContain("NAMESPACE_QUALIFIER_REACHED");expect(receipt).toContain("OS namespace setup failed");
  } else {
    expect(receipt).not.toContain("NAMESPACE_QUALIFIER_REACHED");expect(receipt).toContain("positive native proof requires a hosted runner");
  }
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("RTK plan carries the outer compiled policy read-only without compiler mounts", async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-rtk-policy-"));
 try {
  const file=join(scratch,"plan.json"),script=join(scratch,"parent.ts");
  writeFileSync(script,`import {writeFileSync,readFileSync} from "node:fs";
   import {createHash} from "node:crypto";
   const {enterMeasurementRtkView}=await import(${JSON.stringify(join(ROOT,"scripts/measurement-rtk-fixture.ts"))});
   Bun.spawnSync=(()=>({exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}));
   Bun.spawn=((argv)=>{const target=argv.indexOf("/usr/local/bin/brain-native-connect"),source=argv[target-1];
    writeFileSync(${JSON.stringify(file)},JSON.stringify({argv,source,digest:createHash("sha256").update(readFileSync(source)).digest("hex")}));return {exited:Promise.resolve(0)};});
   await enterMeasurementRtkView();`);
  const child=Bun.spawn([process.execPath,script],{stdout:"pipe",stderr:"pipe"});
  const [code,errors]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect(code,errors).toBe(0);
  const {argv,source,digest}=JSON.parse(readFileSync(file,"utf8"));
  expect(source).toMatch(/odysseus-native-policy-[^/]+\/native-connect$/);
  const at=argv.indexOf("/usr/local/bin/brain-native-connect");expect(argv.slice(at-2,at+1)).toEqual(["--ro-bind",source,"/usr/local/bin/brain-native-connect"]);
  expect(argv).toContain("--native-socket-policy-sha256="+digest);
  expect(argv).not.toContain("/usr/include");expect(argv).not.toContain("/usr/libexec");
 }finally{rmSync(scratch,{recursive:true,force:true});}
});
