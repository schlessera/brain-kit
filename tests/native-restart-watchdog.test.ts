/** Run the actual turn body with a controlled clock and a synthetic backend. */
import { expect,test } from "bun:test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { watchdogMs } from "../scripts/test-deadlines";
test("restart recover watchdog admits its second operation under simulated CPU load",async()=>{
 const source=ts.createSourceFile("restart.ts",readFileSync(join(import.meta.dir,"../packages/ui-backend-claude/tests/native-restart-versions.test.ts"),"utf8"),ts.ScriptTarget.Latest,true);
 let turn:ts.FunctionDeclaration|undefined;function visit(node:ts.Node){if(ts.isFunctionDeclaration(node)&&node.name?.text==="turn")turn=node;ts.forEachChild(node,visit);}visit(source);expect(turn).toBeDefined();
 const code=ts.transpileModule(turn!.getText(source),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 const records:Record<string,unknown>[]=[],timers=new Map<number,{fn:()=>void;ms:number}>();let sequence=0;
 const factory=new Function("expect","watchdogMs","recordNativeRelayTurn","setTimeout","clearTimeout","timers",`
 let mode="read",sent=0,turns=0,environmentCalls=0,runtime,requests=0,sessionId,brain="/synthetic/brain";
 const MEASURED_RUNTIME={claudeCode:"synthetic"};
 const backend={async startTurn(request){environmentCalls++;runtime="synthetic";sent=1;requests++;
  for(const timer of timers.values())if(timer.ms<=21000)timer.fn();
  if(!request.signal.aborted){sent=2;requests++;}
  request.bridge.emit({type:"result",outcome:request.signal.aborted?"cancelled":"success"});
 }};
 ${code}
 return ()=>turn("recover");`);
 const run=factory(expect,(ms:number)=>watchdogMs(ms,{BRAIN_TEST_DEADLINE_FACTOR:"3"}),(value:Record<string,unknown>)=>records.push(value),(fn:()=>void,ms:number)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},(id:number)=>timers.delete(id),timers);
 await run();expect(records).toHaveLength(1);expect(records[0]).toMatchObject({aborted:false,requestDelta:2,outcome:"success",refreshDelta:0});expect(timers.size).toBe(0);
});
