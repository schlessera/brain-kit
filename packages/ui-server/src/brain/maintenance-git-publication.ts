/** Conservative Git selection; the existing publisher handles successful output. */
import {basename} from "node:path";
const REPORT_BYTES=1024*1024;
const entry=(value:string)=>/^(?:brain|brain-cli)(?:\.[cm]?[jt]s)?$/.test(basename(value));
export function routineMaintenance(argv:readonly string[]):boolean {
  const program=argv[0];if(!program)return false;
  if(basename(program)==="brain")return argv[1]==="maintain";
  if(basename(program)!=="bun"&&program!==process.execPath)return false;
  let index=1;
  while(argv[index]==="--no-env-file"||argv[index]?.startsWith("--config="))index++;
  return Boolean(argv[index]&&entry(argv[index]!)&&argv[index+1]==="maintain");
}
/** Host-selected machine output; explicit human callers retain the CLI's rendering. */
export function routineMaintenanceRequest(argv:readonly string[]) {
  if(!routineMaintenance(argv))return undefined;
  const separator=argv.indexOf("--"),end=separator<0?argv.length:separator,options=argv.slice(0,end);
  return {argv:[...options,"--json",...argv.slice(end)],human:options.includes("--human")&&!options.includes("--json")};
}
export interface MaintenanceGitPublication {
  state:"published"|"discarded";
  reason:string|null;
}
type Row={step:string;result:string;trends?:{verdicts?:Array<{state:string;message:string}>}};
/** Complete JSON is the conservative per-run receipt, independent of presentation. */
export function maintenanceResult(code:number,text:string,human=false,readState:{complete:boolean;oversized?:boolean;failed?:boolean}={complete:true}) {
  let rows:Row[]|undefined;
  if(Buffer.byteLength(text)<=REPORT_BYTES){
    try{const value:unknown=JSON.parse(text);if(Array.isArray(value)&&value.every(row=>row&&typeof row==="object"&&typeof row.step==="string"&&typeof row.result==="string"))rows=value;}catch{ /* A partial/invalid result never authorizes Git. */ }
  }
  const git=rows?.filter(row=>row.step==="git");
  let reason:string|null=null;
  if(readState.failed)reason="maintenance_report_read_failed";
  else if(!readState.complete)reason="maintenance_report_incomplete";
  else if(readState.oversized||Buffer.byteLength(text)>REPORT_BYTES)reason="maintenance_report_too_large";
  else if(!rows)reason="maintenance_report_invalid";
  else if(code!==0)reason="maintenance_failed";
  else if(git?.length!==1||!/^ok — packed \d+ loose object\(s\)(?:; garbage: \d+ file\(s\), \d+ bytes)?$/.test(git[0]!.result))reason="git_step_not_ok";
  let stdout=text;
  if(human&&rows){
    stdout="Maintenance run:\n\n";
    for(const row of rows){
      stdout+=`  ${row.step.padEnd(10)} ${row.result}\n`;
      if(Array.isArray(row.trends?.verdicts))for(const verdict of row.trends.verdicts)
        if(verdict&&verdict.state==="warning"&&typeof verdict.message==="string")stdout+=`    ${verdict.message}\n`;
    }
  }
  return {reason,stdout};
}
export function gitPublicationAllowed(code:number,stdout:string):boolean {return maintenanceResult(code,stdout).reason===null;}

/** Drain independently of the caller. Hold at most 1 MiB, then discard excess
 * while draining. After process exit, allow five seconds for owned stdout EOF;
 * a missing EOF is a named discard, never a success inferred from a prefix.
 * The returned display stream queues only one bounded, completed report.
 */
export function captureMaintenanceStdout(input:ReadableStream<Uint8Array>) {
  const reader=input.getReader(),buffer=Buffer.alloc(REPORT_BYTES);
  let size=0,oversized=false,complete=false,failed=false,cancelled=false;
  let display!:ReadableStreamDefaultController<Uint8Array>;
  const stream=new ReadableStream<Uint8Array>({start(controller){display=controller;},cancel(){cancelled=true;}});
  const drained=(async()=>{
    let drainedBytes=0;
    try{for(;;){const next=await reader.read();if(next.done){complete=true;break;}
      const kept=Math.min(next.value.length,REPORT_BYTES-size);buffer.set(next.value.subarray(0,kept),size);size+=kept;
      if(kept<next.value.length)oversized=true;
      // A writer can keep its pipe readable forever; yield to the exit and
      // EOF-deadline handlers even after the capture buffer is full.
      if((drainedBytes+=next.value.length)>=REPORT_BYTES){drainedBytes=0;await Bun.sleep(0);}
    }}catch{failed=true;}finally{reader.releaseLock();}
  })();
  const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{ /* Already released. */ }};
  return {
    stream,cancel,
    async finish(code:number,human:boolean){
      let timer:ReturnType<typeof setTimeout>|undefined;
      const ended=await Promise.race([drained.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);
      clearTimeout(timer);
      if(!ended){complete=false;cancel();}
      return maintenanceResult(code,buffer.subarray(0,size).toString("utf8"),human,{complete:ended&&complete,oversized,failed});
    },
    send(text:string){if(!cancelled){display.enqueue(new TextEncoder().encode(text));display.close();}},
    fail(error:unknown){cancel();if(!cancelled){display.error(error);cancelled=true;}},
  };
}
