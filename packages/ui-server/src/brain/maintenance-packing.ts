/** Host-selected maintenance stages; repository code and Git always run in workers. */
import { basename } from "node:path";
import { WorkerStateError } from "@schlessera/brain-ui-sdk/internal";
import type { BrainExecution, ExecutionResult } from "./host-boundary.js";

export function maintenancePackingCommand(execution: BrainExecution): number {
  if (execution.publish === false || execution.argv.includes("--no-git")) return -1;
  const [program, entry] = execution.argv;
  const name = basename(program ?? "");
  const command = name === "brain" ? 1 : (name === "bun" || program === process.execPath)
    && /(?:^|\/)brain\.(?:ts|js)$/.test(entry ?? "") ? 2 : -1;
  return command >= 0 && execution.argv[command] === "maintain" ? command : -1;
}
export async function runHostedMaintenance(execution: BrainExecution, commandIndex: number,
  run: (execution: BrainExecution) => Promise<ExecutionResult>): Promise<ExecutionResult> {
  const prefix = execution.argv.slice(0, commandIndex);
  const json = !execution.argv.includes("--human");
  const ordinary = await run({ ...execution, discardGit:true, argv: [...execution.argv.filter(arg => arg !== "--human"), "--no-git", "--json"] });
  let report: {step:string;result:string}[];
  try { report=JSON.parse(ordinary.stdout); if(!Array.isArray(report)||!report.some(row=>row.step==="git"))return ordinary; }
  catch {return ordinary;}
  let result: string;
  let garbage: {count:number;bytes:number}|null|undefined;
  try {
    const plan = await run({ ...execution, argv: [...prefix,"storage","pack","--dry-run","--json"], credentials:false,publish:false, onExecute:undefined });
    const parsed=JSON.parse(plan.stdout) as {state:string;reason:string|null;skipReason?:string;garbage?:{count:number;bytes:number};headroom?:{packingRequiredBytes:number}};
    garbage=parsed.garbage;
    if(parsed.reason==="not_a_git_worktree") result="skipped — not a git repository";
    else if(plan.exitCode!==0 && parsed.reason!=="no_space" && parsed.skipReason!=="packing_headroom")
      result=`FAILED — git packing inspection: ${parsed.reason ?? "unavailable"}; Git did not start`;
    else if(plan.exitCode!==0 || parsed.state!=="complete" || !Number.isSafeInteger(parsed.headroom?.packingRequiredBytes) || parsed.headroom!.packingRequiredBytes<=0)
      result="skipped — packing_headroom: packing size could not be established; Git did not start";
    else {
      // Plan includes raw object output, indexes and 16 MiB Git overhead.
      // Add 16 MiB for adapter/scaffolds, then double the image bound so
      // formatted filesystem metadata cannot consume Git's required headroom.
      const packingAllowanceBytes=2*(parsed.headroom!.packingRequiredBytes+16*1024**2);
      const packed=await run({...execution,argv:[...prefix,"storage","pack","--json"],credentials:false,
        outputAreas:[".git"],packingAllowanceBytes,onExecute:undefined});
      const value=JSON.parse(packed.stdout) as {state:string;reason:string|null;skipReason?:string;packed:number|null;headroom?:{availableBytes:number|null};garbage:{count:number;bytes:number}|null};
      result=value.state==="complete" && packed.exitCode===0 ? `ok — packed ${value.packed} loose object(s)`
        : value.state==="refused" && (value.reason==="no_space" || value.skipReason==="packing_headroom") ? `skipped — packing_headroom: ${value.reason}; Git published nothing`
        : `FAILED — git packing: ${value.reason}; Git published nothing`;
      if(value.state==="partial" && value.reason==="no_space") {
        const available=value.headroom?.availableBytes;
        const headroom=available===null || available===undefined ? "available space unknown when the step started" : `${available} bytes available when the step started`;
        result=`FAILED — no space: git packing ran out of space in the dedicated maintenance packing stage (allowance ${packingAllowanceBytes} bytes; ${headroom}); Git published nothing`;
      }
      garbage=value.garbage ?? garbage;
    }
  } catch(error) {
    execution.signal?.throwIfAborted();
    // Capacity refusals are retryable skips. Other faults retain their cause.
    const message=error instanceof Error?error.message:String(error);
    result=error instanceof WorkerStateError && error.errorClass==="worker_state_busy"
      ? `skipped — packing_headroom: ${message}` : `FAILED — git packing: ${message}`;
  }
  if(garbage?.count)result+=`; garbage: ${garbage.count} file(s), ${garbage.bytes} bytes`;
  report=report.map(row=>row.step==="git"?{...row,result}:row);
  const failed=report.some(row=>row.result.startsWith("FAILED"));
  return {...ordinary,exitCode:failed?2:ordinary.exitCode,stdout:json?`${JSON.stringify(report,null,2)}\n`:
    `Maintenance run:\n\n${report.map(row=>`  ${row.step.padEnd(10)} ${row.result}`).join("\n")}\n`,
    stderr:ordinary.stderr+(result.startsWith("FAILED")?`brain maintain: FAILED step(s): git (${result})\n`:"")};
}
