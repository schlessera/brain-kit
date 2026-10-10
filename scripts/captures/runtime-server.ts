import { APPROVAL_CONTENT } from "./fixture-data.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
import type { ChatSession, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { captureSearchFixture, createFixtureBrain } from "./core-fixture.ts";
import { hashTree } from "./provenance.ts";
import { readFontLock } from "./fonts.ts";
import { REFERENCE_INSTANT } from "../../packages/ui-kit/fixtures/time.ts";

const root = resolve(import.meta.dir, "../.."), scratch = process.argv[2], kind = process.argv[3];
if (!scratch || !["capture-search-keyless", "approval-roundtrip"].includes(kind)) throw new Error("Runtime fixture requires an isolated directory and approved ID");
// This dedicated fixture uses only the scripted backend below in a pinned,
// network-denied browser container. It proves approval UI/effects, not worker
// containment. Real host qualification remains in the launcher and gate tests.
if (kind === "approval-roundtrip") workerHostBoundary.probe = () => ({ ok: true });
await mkdir(scratch, { recursive: true });
const brain = resolve(scratch, "brain"), assets = resolve(scratch, "client");
await mkdir(assets, { recursive: true });
const { lock } = await readFontLock(root);
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${escape(lock.preview_stylesheet_url)}"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css">`;
let transcript: Record<string, unknown> | undefined;
if (kind === "capture-search-keyless") {
  transcript = await captureSearchFixture(root, brain);
  const commands = ["brain index --force --json", 'brain add "Raft supplies: timber, rope and fresh water for Odysseus’s crossing from Ogygia." --type note --title "Raft supplies" --json', 'brain search "raft supplies" --mode fts --rerank none --json'];
  await writeFile(resolve(assets, "index.html"), `<!doctype html><html data-theme="light"><head>${head}<style>body{margin:0;padding:28px;background:var(--bk-color-canvas);color:var(--bk-color-ink);font:14px/1.6 "JetBrains Mono",monospace}h1{font:32px "DM Serif Text",serif}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid var(--bk-color-edge);border-radius:8px}section{margin:22px 0}</style></head><body><main><h1>Odysseus’s notebook</h1><p>Capture a note · retrieve its indexed text · FTS</p>${[transcript.index,transcript.add,transcript.search].map((result,i)=>`<section><pre>$ ${escape(commands[i])}</pre><pre>${escape(JSON.stringify(result,null,2))}</pre></section>`).join("")}<section><h2>Written Markdown</h2><pre>${escape(transcript.markdown as string)}</pre></section></main></body></html>`);
} else {
  await createFixtureBrain(root, brain);
  const built = await Bun.build({ entrypoints: [resolve(root, "scripts/captures/runtime-client.ts")], target: "browser", outdir: assets, naming: "client.js" });
  if (!built.success) throw new Error(`approval-roundtrip: actual client build failed: ${built.logs.join("; ")}`);
  await writeFile(resolve(assets, "index.html"), `<!doctype html><html data-theme="dark" class="dark"><head>${head}<style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>`);
}
await writeFile(resolve(assets, "kit.css"), await readFile(resolve(root, "packages/ui-kit/dist/styles.css")));
await writeFile(resolve(assets, "app.css"), await readFile(resolve(root, "packages/ui-react/dist/styles.css")));
let sequence = 0;
const histories = resolve(scratch, "history.json");
await writeFile(histories, "{}\n");
const history = async () => JSON.parse(await readFile(histories,"utf8")) as Record<string, SessionHistoryMessage[]>;
const sessions: ChatSession[] = [];
const backend: AgentBackend = {
  id: "capture-scripted", capabilities: { resume:true, permissions:true, thinking:false, attachments:false, askUser:false, costReporting:false, concurrentSessions:false, followUp:false },
  listProfiles: () => [{ id: "capture-scripted", label: "Local fixture · no model" }],
  listSessions: async () => sessions, getHistory: async (id) => (await history())[id] ?? [],
  async startTurn({ prompt, bridge,signal,sessionId }) {
    sequence++;
    const id = sessionId ?? `odysseus-approval-${sequence}`, toolUseId = `raft-write-${sequence}`;
    const input = { file_path: `notes/raft-supplies-${sequence}.md`, content: APPROVAL_CONTENT };
    bridge.emit({ type: "session_info", sessionId:id, isNew:!sessionId });
    bridge.emit({ type: "tool_use_start", sessionId:id, toolUseId, toolName:"Write" });
    bridge.emit({ type: "tool_use_complete", sessionId:id, toolUseId, toolName:"Write", input });
    let decision;
    try { decision = await bridge.requestPermission({ toolUseId, toolName:"Write", input, kind:"command", description:"Write this one fictional raft-supplies note in the isolated fixture brain." }); }
    catch (error) {
      if (signal.aborted) { bridge.emit({type:"status",sessionId:id,status:"cancelled"}); return; }
      bridge.emit({type:"error",code:"CAPTURE_BACKEND_ERROR",sessionId:id,message:(error as Error).message}); return;
    }
    if (decision.behavior === "allow") await writeFile(resolve(brain,input.file_path), input.content);
    const output = decision.behavior === "allow" ? `Written ${input.file_path}: ${input.content}` : `Refused ${input.file_path}; no file written.`;
    const stored = await history();
    stored[id] = [...(stored[id]??[]),{ role:"user", content:prompt, toolCalls:[] }, { role:"assistant", content:output, toolCalls:[{ id:toolUseId,name:"Write",input,output,isError:decision.behavior==="deny" }] }];
    await writeFile(histories,JSON.stringify(stored)+"\n");
    const session=sessions.find((session)=>session.id===id);
    if(session){session.numTurns++;session.lastActiveAt=REFERENCE_INSTANT.getTime();}
    else sessions.push({ id,title:prompt,createdAt:REFERENCE_INSTANT.getTime(),lastActiveAt:REFERENCE_INSTANT.getTime(),totalCostUsd:0,numTurns:1 });
    bridge.emit({ type:"tool_result", sessionId:id,toolUseId,output,isError:decision.behavior==="deny" });
    bridge.emit({ type:"text_delta", sessionId:id,text:output });
    bridge.emit({ type:"result", sessionId:id,outcome:"success",durationMs:0,numTurns:1,isError:false });
  },
};
const app = await createApp({ config:resolveServerConfig({ BRAIN_PATH:brain, DB_PATH:resolve(scratch,"ui.db"), AUTH_MODE:"none", HOST:"127.0.0.1", NODE_ENV:"test", BRAIN_UI_PRICING_DISCOVERY:"0", BRAIN_UI_MODEL_DISCOVERY:"0" }), staticRoot:assets,
  registry:createStaticBackendRegistry([backend],backend.id),observability:createRecordingObservability(),turnTimeoutMs:20_000 });
const server = Bun.serve({ hostname:"127.0.0.1",port:0,websocket:app.websocket,
  async fetch(request,server) {
    if (new URL(request.url).pathname === "/capture-evidence") {
      const events = app.db.query("SELECT span_id,event_type,payload FROM activity_events WHERE event_type = 'approval_decision' ORDER BY span_id").all();
      const files = await Promise.all([1,2].map(async (n)=>{try{return { path:`notes/raft-supplies-${n}.md`,content:await readFile(resolve(brain,`notes/raft-supplies-${n}.md`),"utf8") };}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return { path:`notes/raft-supplies-${n}.md`,content:null };}}));
      return Response.json({ events,files,history:await history(),transcript });
    }
    return app.fetch(request,server);
  },
});
const runtimeBuildHash = await hashTree(scratch,"client");
console.log(JSON.stringify({ runtime_build_sha256:runtimeBuildHash, origin:`http://127.0.0.1:${server.port}`,kind }));
const close = async () => {server.stop(true);app.cancelActiveTurns();await app.close();process.exit(0);};
process.on("SIGTERM",()=>void close()); process.on("SIGINT",()=>void close());
