import {expect,test} from "bun:test";
import {routineMaintenance,captureMaintenanceStdout,maintenanceResult,routineMaintenanceRequest} from "../src/brain/maintenance-git-publication.js";
const ok=JSON.stringify([{step:"git",result:"ok — packed 7 loose object(s)"}]);
test("maintain argv matches the executable and immediate subcommand only",()=>{
 for(const argv of [["brain","maintain","--json"],["/ithaca/.bin/brain","maintain"],["bun","scripts/brain-cli.ts","maintain"],[process.execPath,"--config=/dev/null","--no-env-file","/ithaca/brain.ts","maintain"]])expect(routineMaintenance(argv),"MAINTAIN_ARGV_ACCEPTS_CLI").toBe(true);
 for(const argv of [["git","-C","/ithaca/brain","tag","maintain"],["brain","read","maintain"],["bun","-e","brain","maintain"],["bun","other.ts","brain","maintain"],["brain","module","maintain"]])expect(routineMaintenance(argv),"MAINTAIN_ARGV_REJECTS_OTHER_COMMANDS").toBe(false);
});
test("only a zero exit and a complete parsed Git-ok report permit Git publication",()=>{
 expect((maintenanceResult(0,ok).reason===null)).toBe(true);
 for(const [code,output]of [[1,ok],[2,ok],[0,ok.slice(0,-2)],[0,'{"step":"git","result":"ok — packed 7 loose object(s)'],[0,"Maintenance run:\n  git        ok — packed 7 loose object(s)"],[0,JSON.stringify([{step:"git",result:"skipped — packing_headroom"}])],[0,JSON.stringify([{step:"git",result:"FAILED — refused"}])],[0,JSON.stringify([{step:"git",result:"ok — packed 7 loose object(s)"},{step:"git",result:"FAILED"}])]] as const)expect((maintenanceResult(code,output).reason===null),"GIT_PUBLICATION_REQUIRES_COMPLETE_ZERO_EXIT").toBe(false);
});
test("host requests JSON while preserving explicit human presentation",()=>{
 expect(routineMaintenanceRequest(["brain","maintain"])?.argv).toEqual(["brain","maintain","--json"]);
 expect(routineMaintenanceRequest(["brain","maintain","--human","--"])?.argv).toEqual(["brain","maintain","--human","--json","--"]);
 const report=JSON.stringify([{step:"git",result:"ok — packed 7 loose object(s)"},{step:"stats",result:"ok",trends:{verdicts:[{state:"warning",message:"Ithaca awaits supplies"}]}}]);
 expect(maintenanceResult(0,report,true).stdout,"HUMAN_MAINTENANCE_OUTPUT_UNCHANGED").toBe("Maintenance run:\n\n  git        ok — packed 7 loose object(s)\n  stats      ok\n    Ithaca awaits supplies\n");
});
test("capture waits for completed output independently of the caller's reader",async()=>{
 let controller!:ReadableStreamDefaultController<Uint8Array>;
 const report=captureMaintenanceStdout(new ReadableStream({start(value){controller=value;}}));
 const finished=report.finish(0,false);
 controller.enqueue(new TextEncoder().encode(ok));controller.close();
 const result=await finished;
 expect(result.reason,"DRAIN_COMPLETION_AUTHORIZES_GIT").toBeNull();
 report.send(result.stdout);expect(await new Response(report.stream).text()).toBe(ok);
 const huge=" ".repeat(1024*1024)+ok,large=captureMaintenanceStdout(new Response(huge).body!);
 const oversized=await large.finish(0,false);expect(oversized.reason).toBe("maintenance_report_too_large");expect(Buffer.byteLength(oversized.stdout),"REPORT_CAPTURE_HAS_FIXED_BYTE_BOUND").toBe(1024*1024);large.send(oversized.stdout);await large.stream.cancel();
});
