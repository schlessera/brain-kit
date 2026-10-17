/** Invoked inside a network namespace by measure-startup.ts and the runtime test. */
import { cpSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createPiBackend } from "../../src/backend.js";
import { savePiSession, readPiSession } from "../../src/session-storage.js";
import { prepareWorkerSandbox } from "../../../ui-sdk/src/server/worker-launcher.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";

const root = process.argv[2]!;
const brain = join(root, "brain"), agent = join(root, "agent"), sessions = join(root, "sessions");
cpSync(resolve("packages/core/fixtures/corpus"), brain, { recursive: true });
const config = join(brain, "brain.config.ts");
writeFileSync(config, readFileSync(config, "utf8").replace(JSON.stringify("@schlessera/brain"), JSON.stringify(resolve("packages/core/src/index.ts"))));
mkdirSync(agent); mkdirSync(sessions);
process.env.PI_CODING_AGENT_DIR = agent;
const extension = join(brain, ".pi/extensions"); mkdirSync(extension, { recursive: true });
writeFileSync(join(extension, "startup.ts"), `import { statSync, writeFileSync, existsSync, readlinkSync } from "node:fs";
export default function(pi) {
  pi.registerTool({ name: "startup_identity", label: "Identity", description: "Report this isolated worker", parameters: {type:"object",properties:{}},
    async execute() {
      const scratch = "/tmp/brain-worker-scratch";
      const marker = scratch + "/startup-marker";
      const prior = existsSync(marker); writeFileSync(marker, "Odysseus");
      let homeReadOnly = false;
      try { writeFileSync(process.env.HOME + "/startup-marker", "Odysseus"); } catch(error) { homeReadOnly = error.code === "EROFS"; }
      return { content: [{type:"text",text:JSON.stringify({homeReadOnly,scratch,mountNamespace:readlinkSync("/proc/self/ns/mnt"),prior})}], details:{} };
    } });
}`);
const rows: any[] = []; let current: any; let turnCalls = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as any;
  if (turnCalls++ === 0) current.providerRequestMs = performance.now() - current.started;
  const tool = turnCalls === 1;
  if (tool && !body.tools?.some((t: any) => t.name === "startup_identity")) throw new Error("Extension was not loaded");
  const events: any[] = [{type:"message_start",message:{id:"msg_odysseus",type:"message",role:"assistant",model:"claude-sonnet-4-6",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
    {type:"content_block_start",index:0,content_block:tool ? {type:"tool_use",id:"identity",name:"startup_identity",input:{}} : {type:"text",text:""}},
    {type:"content_block_delta",index:0,delta:tool ? {type:"input_json_delta",partial_json:"{}"} : {type:"text_delta",text:"Odysseus sails to Ithaca."}},
    {type:"content_block_stop",index:0}, {type:"message_delta",delta:{stop_reason:tool ? "tool_use" : "end_turn",stop_sequence:null},usage:{output_tokens:5}}, {type:"message_stop"}];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {headers:{"content-type":"text/event-stream"}});
} });
writeFileSync(join(agent,"models.json"), JSON.stringify({providers:{anthropic:{baseUrl:server.url.origin,apiKey:"offline-fixture"}}}));
writeFileSync(join(agent,"settings.json"), JSON.stringify({retry:{enabled:false}}));
const backend = createPiBackend({brainPath:brain,sessionDir:sessions,profiles:[{id:"fixture",label:"Fixture",vendor:"anthropic",model:"claude-sonnet-4-6",thinkingLevel:"off"}],
  log(_level, message, meta) { if (current && message.startsWith("Pi startup")) current.phases.push({message,...meta}); } });
const sandbox = prepareWorkerSandbox(brain,{profile:"strict",areas:[]});
async function run(kind: string, sessionId?: string) {
  current = {kind,started:performance.now(),phases:[],frames:[]}; turnCalls=0;
  await startFixtureTurn(backend,brain,{sessionId,prompt:"Continue the voyage",profileId:"fixture",signal:AbortSignal.timeout(20000),workerSandbox:sandbox,
    workerStarted(worker) { current.workerPid = (worker as unknown as {pid:number}).pid; },
    bridge:{emit(frame) { if (current.firstFrameMs === undefined) current.firstFrameMs=performance.now()-current.started; current.frames.push(frame); },requestPermission:async()=>({behavior:"allow"})}});
  const terminal = current.frames.at(-1);
  if (terminal?.type !== "result" || terminal.outcome !== "success") throw new Error(JSON.stringify(current.frames));
  const identity = current.frames.find((f:any)=>f.type==="tool_result" && f.toolUseId==="identity" && !f.isError);
  if (!identity) throw new Error(JSON.stringify(current.frames));
  current.identity = JSON.parse(identity.output);
  current.sessionId = current.frames.find((f:any)=>f.type==="session_info").sessionId;
  delete current.frames; delete current.started; rows.push(current);
  return current.sessionId as string;
}
try {
  const id = await run("new");
  const entries = readPiSession(join(sessions,`${id}.jsonl`));
  // Non-trivial selected transcript, plus a realistic archive that must not be parsed to resume it.
  let parentId: any = entries.at(-1)!.id;
  for(let i=0;i<32;i++) { const next=randomUUID(); entries.push({type:"message",id:next,parentId,timestamp:"2026-07-12T00:00:00.000Z",message:{role:"user",content:"Odysseus records the voyage. ".repeat(256),timestamp:0}} as any); parentId=next; }
  savePiSession(sessions,id,entries);
  for(let i=0;i<128;i++) { const other=randomUUID(); savePiSession(sessions,other,[{type:"session",version:3,id:other,cwd:brain,timestamp:"2026-07-12T00:00:00.000Z"},...entries.slice(1)]); }
  await run("resumed",id);
  console.log(JSON.stringify({archiveSessions:128,selectedTranscriptBytes:statSync(join(sessions,`${id}.jsonl`)).size,rows}));
} finally { server.stop(true); }
