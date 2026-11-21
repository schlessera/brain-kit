import { expect,test } from "bun:test";
import { join } from "node:path";
import { nativeRtkFailureCategory } from "../scripts/native-rtk-diagnostics";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";
const cases={"no-owned-match":"native fixture RTK payload missing","multiple-match":"native fixture RTK payload ambiguous","start-mismatch":"native fixture RTK audited identity changed","exe-mismatch":"native fixture RTK executable changed","launch-mismatch":"native fixture RTK spawn is unregistered","register-refused":"unrecognized adapter failure"};
for(const [category,message] of Object.entries(cases))test(`RTK diagnostic emits ${category} and rethrows`,async()=>{
 const module=join(import.meta.dir,"../scripts/native-rtk-diagnostics.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`import {diagnoseNativeFixtureRtk} from ${JSON.stringify(module)};const original=Error(${JSON.stringify(message)});let caught;try{diagnoseNativeFixtureRtk(()=>{throw original;});}catch(error){caught=error;}if(caught!==original)throw Error("RTK_REFUSAL_MUST_RETHROW");`]);
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);expect(code,out).toBe(0);
 const record=JSON.parse(out.split("\n").find(line=>line.startsWith('{"kind":"native-fixture-rtk-registration"'))!);
 expect(record).toMatchObject({success:false,category});expect(Object.keys(record).sort()).toEqual(["kind","head","success","category"].sort());
});
test("RTK diagnostic categories cannot carry arbitrary private text",()=>{
 for(const error of [Error("/home/private-owner/secret TOKEN=private-value https://ithaca.invalid"),"private-value",{message:"native fixture RTK executable changed"}])expect(nativeRtkFailureCategory(error),"RTK_CATEGORY_IS_FIXED_AND_SCRUBBED").toBe("register-refused");
});

test("measurement fixture records its adapter refusal before rethrowing",async()=>{
 const fixture=join(import.meta.dir,"../scripts/measurement-worker-fixture.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`import {mkdtempSync,rmSync} from "node:fs";import {createMeasurementWorkerFixture} from ${JSON.stringify(fixture)};const brain=mkdtempSync("/tmp/odysseus-rtk-refusal-");const fixture=createMeasurementWorkerFixture(brain);let refused=false;try{fixture.qualifyRtk();}catch{refused=true;}finally{fixture.cleanup();rmSync(brain,{recursive:true,force:true});}if(!refused)throw Error("FIXTURE_RTK_REFUSAL_MUST_PROPAGATE");`]);
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);expect(code,out).toBe(0);expect(out,"MEASUREMENT_RTK_REFUSAL_IS_OBSERVABLE").toContain('"category":"launch-mismatch"');
});
