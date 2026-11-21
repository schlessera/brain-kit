import {expect,test} from "bun:test";
import {routineMaintenance,gitPublicationAllowed,observeMaintenanceStdout} from "../src/brain/maintenance-git-publication.js";
const ok=JSON.stringify([{step:"git",result:"ok — packed 7 loose object(s)"}]);
test("maintain argv matches the executable and immediate subcommand only",()=>{
 for(const argv of [["brain","maintain","--json"],["/ithaca/.bin/brain","maintain"],["bun","scripts/brain-cli.ts","maintain"],[process.execPath,"--config=/dev/null","--no-env-file","/ithaca/brain.ts","maintain"]])expect(routineMaintenance(argv),"MAINTAIN_ARGV_ACCEPTS_CLI").toBe(true);
 for(const argv of [["git","-C","/ithaca/brain","tag","maintain"],["brain","read","maintain"],["bun","-e","brain","maintain"],["bun","other.ts","brain","maintain"],["brain","module","maintain"]])expect(routineMaintenance(argv),"MAINTAIN_ARGV_REJECTS_OTHER_COMMANDS").toBe(false);
});
test("only a zero exit and a complete parsed Git-ok report permit Git publication",()=>{
 expect(gitPublicationAllowed(0,ok)).toBe(true);
 for(const [code,output]of [[1,ok],[2,ok],[0,ok.slice(0,-2)],[0,'{"step":"git","result":"ok — packed 7 loose object(s)'],[0,"Maintenance run:\n  git        ok — packed 7 loose object(s)"],[0,JSON.stringify([{step:"git",result:"skipped — packing_headroom"}])],[0,JSON.stringify([{step:"git",result:"FAILED — refused"}])],[0,JSON.stringify([{step:"git",result:"ok — packed 7 loose object(s)"},{step:"git",result:"FAILED"}])]] as const)expect(gitPublicationAllowed(code,output),"GIT_PUBLICATION_REQUIRES_COMPLETE_ZERO_EXIT").toBe(false);
});
test("streamed reports never delay exit and oversized/missing EOF discard only Git",async()=>{
 let controller!:ReadableStreamDefaultController<Uint8Array>;
 const input=new ReadableStream<Uint8Array>({start(value){controller=value;}}),observed=observeMaintenanceStdout(input);
 expect(observed.gitSucceeded(0),"UNREAD_REPORT_DISCARDS_GIT").toBe(false);
 const output=new Response(observed.stream).text();controller.enqueue(new TextEncoder().encode(ok));controller.close();
 expect(await output).toBe(ok);expect(observed.gitSucceeded(0)).toBe(true);expect(observed.gitSucceeded(2)).toBe(false);
 const huge=" ".repeat(1024*1024)+ok;
 const large=observeMaintenanceStdout(new Response(huge).body!);expect(await new Response(large.stream).text(),"OVERSIZED_OUTPUT_STILL_STREAMS").toBe(huge);expect(large.gitSucceeded(0),"OVERSIZED_REPORT_DISCARDS_GIT").toBe(false);
});
