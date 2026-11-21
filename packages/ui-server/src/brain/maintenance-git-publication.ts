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
export function gitPublicationAllowed(code:number,stdout:string):boolean {
  if(code!==0||Buffer.byteLength(stdout)>REPORT_BYTES)return false;
  let rows:unknown;try{rows=JSON.parse(stdout);}catch{return false;}
  if(!Array.isArray(rows)||!rows.every(row=>row&&typeof row==="object"&&typeof row.step==="string"&&typeof row.result==="string"))return false;
  const git=rows.filter(row=>row.step==="git");
  return git.length===1&&/^ok — packed \d+ loose object\(s\)(?:; garbage: \d+ file\(s\), \d+ bytes)?$/.test(git[0].result);
}
/** Capture only bytes already streamed to the reader. Never delay exit for EOF:
 * unread, cancelled, oversized or incomplete reports conservatively discard Git.
 * This also permits a caller to await exit before draining its output.
 */
export function observeMaintenanceStdout(input:ReadableStream<Uint8Array>) {
  let parts:Buffer[]=[],bytes=0,complete=false,oversized=false;
  const stream=input.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>REPORT_BYTES){oversized=true;parts=[];}else if(!oversized)parts.push(Buffer.from(chunk));controller.enqueue(chunk);},
    flush(){complete=true;},
  }));
  return {stream,gitSucceeded(code:number){return complete&&!oversized&&gitPublicationAllowed(code,Buffer.concat(parts).toString());}};
}
