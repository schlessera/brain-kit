/** Generate an isolated derivative of the existing real-worker fixture. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
let source = readFileSync("tests/fixtures/pi-worker-probe.ts", "utf8");
function replaceOnce(before: string, after: string): string {
  if (!source.includes(before)) throw new Error("Fixture anchor moved: " + before.slice(0, 60));
  return source.replace(before, after);
}
const start = source.indexOf("const extensionSource = `");
const end = source.indexOf("writeFileSync(join(extensionDir,", start);
if (start < 0 || end < 0) throw new Error("Fixture anchors moved; inspect before updating.");
const extension = `import {readFileSync} from "node:fs";
export default function(pi) { pi.registerTool({name:"probe_worker",label:"Worker denial",description:"Fictional private path proof",parameters:{type:"object",properties:{}},async execute() {
  let denied=0; for(const path of ["/root/search-executors/private-credential","/root/search-executors/ithaca/web-search.json"]){try{readFileSync(path); }catch{denied++;}}
  if(denied!==2) throw new Error("WORKER_PRIVATE_SENTINELS_DENIED");
  return {content:[{type:"text",text:"WORKER_PRIVATE_SENTINELS_DENIED"}],details:null};
}}); }`;
source = source.slice(0, start) + `const extensionSource = ${JSON.stringify(extension)};\n` + source.slice(end);
source = `import {runSearch,runForeignSearch,resultId,finishSearch} from ${JSON.stringify(resolve("experiments/host-web-search/host.ts"))};\n` + source;
source = replaceOnce("const server = Bun.serve", 'toolCalls = [{name:"probe_worker",input:{}},{name:"query_activity",input:{scope:"run",runId:"Odysseus mast"}}];\nconst server = Bun.serve');
source = replaceOnce('const bridge = { emit', 'const bridge = { queryActivity: (async (input:any) => { if ([...hostPids].filter(pid => existsSync(`/proc/${pid}`)).length < 2) throw new Error("ACTUAL_WORKER_LIFETIMES_OVERLAP"); return runSearch(input); }) as any, emit');
source = replaceOnce('const chosen = calls === 1 ? toolCalls : calls === 2 ? followUp : [];', `const messages = (body as any).messages;
  const foreign = JSON.stringify(messages).includes("Troy proof");
  const chosen = messages.some((m:any)=>m.role==="assistant") ? [] : foreign
    ? [{name:"query_activity",input:{scope:"run",runId:await resultId()}}] : toolCalls;`);
source = replaceOnce('try { await startFixtureTurn(backend, brainPath, { prompt:', `try { const foreignFrames: any[] = [];
    const foreignTurn = startFixtureTurn(backend, brainPath, { prompt: "Troy proof", profileId: "fixture", signal: controller.signal,
      bridge: {...bridge, queryActivity: runForeignSearch as any, emit(frame:any) {foreignFrames.push(frame);}},
      ...(stateSandbox ? {workerSandbox:stateSandbox}: {}) });
    await startFixtureTurn(backend, brainPath, { prompt:`);
source = replaceOnce('...(scenario === "forge-bridge" ? { enforceAllowedTools: true, noGrantSurface: true } : {}) }); }', `...(scenario === "forge-bridge" ? { enforceAllowedTools: true, noGrantSurface: true } : {}) });
    await foreignTurn;
    if (!foreignFrames.some((f:any)=>f.type==="tool_result" && !f.isError) || foreignFrames.some((f:any)=>f.output?.includes("Athena"))) throw new Error("FOREIGN_WORKER_REPLAY_DENIED");
    console.error(JSON.stringify({foreignWorkerFrames:foreignFrames})); }`);
source = replaceOnce('const sessions = await backend.listSessions();', 'if (failure) throw new Error(failure);\n  if (!frames.some((f:any)=>f.type==="tool_result" && f.output?.includes("Athena"))) throw new Error("WORKER_RECEIVED_HOST_RESULT");\n  if (!frames.some((f:any)=>f.type==="tool_result" && f.output?.includes("WORKER_PRIVATE_SENTINELS_DENIED") && !f.isError)) throw new Error("WORKER_DENIAL_PROOF");\n  const sessions = await backend.listSessions();');
source = replaceOnce('finally { clearTimeout(deadline);', 'finally { await finishSearch(); clearTimeout(deadline);');
writeFileSync("tests/fixtures/host-search-1969.generated.ts", source, { flag: "wx" });
