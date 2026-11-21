/** Test-only startup evidence; never write raw stderr, argv or environment. */
import type { Readable } from "node:stream";
import { createRedactor } from "../../../compute-boat/src/redact.js";
import { redactCredentials } from "../../../ui-server/src/activity/runtime-status.js";
import { redactProviderMessage } from "../../../ui-react/src/lib/turn-failure.js";

export const STARTUP_STDERR_BYTES = 32768;
interface StartupWorker { stderr: Readable; exited: Promise<number> }
interface BootstrapStatus { exitCode: number | null; signalCode: string | number | null }

export function observeNativeWorkerStartup(worker: StartupWorker, bootstrap: BootstrapStatus, secrets: readonly string[]): void {
  const redactor=createRedactor(undefined);for(const secret of secrets)redactor.add(secret);
  // These are the existing outcome/log and Activity/provider-receipt scrubbers.
  const scrub=(text:string)=>redactProviderMessage(redactCredentials(redactor.text(text)));
  const chunks:Buffer[]=[];let retained=0,observed=0,flushed=false;
  const data=(chunk:Buffer|string)=>{
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);observed+=bytes.length;
    const keep=Math.min(bytes.length,STARTUP_STDERR_BYTES-retained);
    if(keep>0){chunks.push(Buffer.from(bytes.subarray(0,keep)));retained+=keep;}
  };
  const flush=()=>{
    if(flushed)return;flushed=true;worker.stderr.off("data",data);
    let text=Buffer.concat(chunks).toString("utf8");
    // Never print a partial trailing credential when the prefix was capped.
    if(observed>retained)text=text.slice(0,Math.max(0,text.lastIndexOf("\n")));
    console.error(JSON.stringify({kind:"native-fixture-startup-stderr",retainedBytes:retained,observedBytes:observed,
      truncated:observed>retained,text:scrub(text)}));
    chunks.length=0;
  };
  worker.stderr.on("data",data);worker.stderr.once("end",flush);worker.stderr.once("close",flush);
  worker.stderr.once("error",error=>{flush();console.error(JSON.stringify({kind:"native-fixture-stderr-error",message:scrub(String(error))}));});
  void worker.exited.then(code=>{
    console.error(JSON.stringify({kind:"native-fixture-worker-exit",exitCode:code,signal:bootstrap.signalCode,signalScope:"worker-bootstrap",bootstrapExitCode:bootstrap.exitCode}));
  },error=>{
    console.error(JSON.stringify({kind:"native-fixture-worker-exit",exitCode:null,signal:bootstrap.signalCode,signalScope:"worker-bootstrap",bootstrapExitCode:bootstrap.exitCode,message:scrub(String(error))}));
  }).finally(()=>{setTimeout(flush,2000).unref();});
}
