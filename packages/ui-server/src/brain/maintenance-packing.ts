/** Host-selected maintenance stages; repository code and Git always run in workers. */
import type { BrainExecution, ExecutionResult } from "./host-boundary.js";

export function maintenancePackingCommand(execution: BrainExecution): number {
  return execution.publish === false || execution.argv.includes("--no-git") ? -1 : execution.argv.indexOf("maintain");
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
    const parsed=JSON.parse(plan.stdout) as {state:string;reason:string|null;garbage?:{count:number;bytes:number};headroom?:{packingRequiredBytes:number}};
    garbage=parsed.garbage;
    if(parsed.reason==="not_a_git_worktree") result="skipped — not a git repository";
    else if(plan.exitCode!==0 || parsed.state!=="complete" || !Number.isSafeInteger(parsed.headroom?.packingRequiredBytes) || parsed.headroom!.packingRequiredBytes<=0)
      result="skipped — packing_headroom: packing size could not be established; Git did not start";
    else {
      // Plan includes raw object output, indexes and 16 MiB Git overhead.
      // Another 16 MiB covers the frozen Git adapter and publication scaffolds.
      const packingAllowanceBytes=parsed.headroom!.packingRequiredBytes+16*1024**2;
      const packed=await run({...execution,argv:[...prefix,"storage","pack","--json"],credentials:false,
        outputAreas:[".git"],packingAllowanceBytes,onExecute:undefined});
      const value=JSON.parse(packed.stdout) as {state:string;reason:string|null;packed:number|null;garbage:{count:number;bytes:number}|null};
      result=value.state==="complete" && packed.exitCode===0 ? `ok — packed ${value.packed} loose object(s)`
        : value.state==="refused" ? `skipped — packing_headroom: ${value.reason}; Git published nothing`
        : `FAILED — git packing: ${value.reason}; Git published nothing`;
      garbage=value.garbage ?? garbage;
    }
  } catch(error) {
    execution.signal?.throwIfAborted();
    // Capacity refusals are retryable skips. Other faults retain their cause.
    const message=error instanceof Error?error.message:String(error);
    result=/packing_headroom|capacity|staging|worker_state_busy/i.test(message)
      ? `skipped — packing_headroom: ${message}` : `FAILED — git packing: ${message}`;
  }
  if(garbage?.count)result+=`; garbage: ${garbage.count} file(s), ${garbage.bytes} bytes`;
  report=report.map(row=>row.step==="git"?{...row,result}:row);
  const failed=report.some(row=>row.result.startsWith("FAILED"));
  return {...ordinary,exitCode:failed?2:ordinary.exitCode,stdout:json?`${JSON.stringify(report,null,2)}\n`:
    `Maintenance run:\n\n${report.map(row=>`  ${row.step.padEnd(10)} ${row.result}`).join("\n")}\n`,
    stderr:ordinary.stderr+(result.startsWith("FAILED")?`brain maintain: FAILED step(s): git (${result})\n`:"")};
}
