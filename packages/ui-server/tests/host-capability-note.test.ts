import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { workerSandboxNote } from "@schlessera/brain-ui-sdk/internal";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFixtureApp as createApp } from "./helpers/native-app-fixture.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { WsHost } from "../src/ws/host.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { fakeLiveProvider, SILENCE } from "./helpers/live-conversation.js";

async function until(check:()=>boolean, diagnostic:()=>unknown) {const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error(JSON.stringify(diagnostic()));await Bun.sleep(5);}}

test("actual hosted admission supplies only real journal/revert capabilities, including voice and hosts missing either service",async()=>{
 const root=await mkdtemp(resolve(tmpdir(),"odysseus-capability-note-")),brain=resolve(root,"brain");await createFixtureBrain(resolve(import.meta.dir,"../../.."),brain);
 // The CLI fixture links dependencies; this valid test policy releases only
 // that tier-B path so the note exercise admits governed instead of fallback.
 await mkdir(resolve(brain,"context/policies"),{recursive:true});await writeFile(resolve(brain,"context/policies/governance.md"),"---\nschema_version: 1\nprofiles: { interactive: governed, voice: governed }\nrelease: [node_modules]\n---\nAthena's fixture policy.\n");
 const requests:StartTurnRequest[]=[], live=fakeLiveProvider();
 const backend=makeFakeBackend({id:"capability-note",startTurn:async req=>{requests.push(req);const sessionId=`sess-ithaca-${requests.length}`;req.bridge.emit({type:"session_info",sessionId,isNew:true});req.bridge.emit({type:"text_delta",text:"Athena records the return."});req.bridge.emit({type:"result",sessionId,outcome:"success",durationMs:1,numTurns:1,isError:false});}});
 const registry=createStaticBackendRegistry([backend],backend.id);
 const app=await createApp({config:resolveServerConfig({BRAIN_PATH:brain,DB_PATH:resolve(root,"ui.db"),HOST:"127.0.0.1",AUTH_MODE:"none",NODE_ENV:"test",BRAIN_UI_MODEL_DISCOVERY:"0",BRAIN_UI_PRICING_DISCOVERY:"0"}),registry,conversationProvider:live.provider,observability:createRecordingObservability()});
 const principal=createPrincipal(app.db,{authMethod:"password",label:"Odysseus note",ttlSeconds:60}), extraHosts:WsHost[]=[];
 async function connect(host:WsHost){const handlers=createWsHandlers(host,principal),sent:string[]=[],ws={send:(text:string)=>sent.push(text),close(){},readyState:1} as WSContext;await handlers.onOpen(undefined as never,ws);return{handlers,ws,sent,send(frame:unknown){handlers.onMessage({data:JSON.stringify(frame)} as MessageEvent,ws);},close(){handlers.onClose({code:1000} as CloseEvent,ws);}};}
 async function chat(host:WsHost){const seen=requests.length,connection=await connect(host);connection.send({type:"chat_message",text:"Record the return to Ithaca",requestId:`note-${seen}`});await until(()=>requests.length===seen+1&&!host.coordinator.isTurnActive(),()=>connection.sent);connection.close();return requests.at(-1)!;}
 try {
  const hosted=await chat(app.wsHost);expect(hosted.workerSandbox?.profile,"HOST_NOTE_ACTUAL_GOVERNED_PROFILE").toBe("governed");expect(workerSandboxNote(hosted.workerSandbox!),"HOST_WIRED_CAPABILITY_NOTE").toContain("Host change journaling is active for this turn.");expect(hosted.workerSandbox?.noteFacts?.history).toEqual({journal:true,userRevert:true});
  const connection=await connect(app.wsHost);connection.send({type:"conversation_start"});await until(()=>live.sessions.length===1,()=>connection.sent);await until(()=>connection.sent.some(text=>JSON.parse(text).type==="conversation_opened"),()=>connection.sent);
  const opened=connection.sent.map(text=>JSON.parse(text)).find(frame=>frame.type==="conversation_opened"),voice=live.sessions[0]!;
  connection.send({type:"conversation_audio",conversationId:opened.conversationId,epoch:opened.epoch,utteranceId:"u-ithaca",sequence:0,rate:16000,pcm:SILENCE});await until(()=>voice.audio.length===1,()=>connection.sent);voice.emit({kind:"input_fragment",utteranceId:"u-ithaca",sequence:0,text:"Record Athena's advice",finalization:"unknown",certainty:"unknown",origin:"user"});
  await until(()=>connection.sent.some(text=>JSON.parse(text).type==="conversation_event"),()=>connection.sent);const seen=requests.length;
  connection.send({type:"conversation_commit",conversationId:opened.conversationId,epoch:opened.epoch,utteranceId:"u-ithaca",requestId:"voice-note",text:"Record Athena's advice"});await until(()=>requests.length===seen+1&&!app.wsHost.coordinator.isTurnActive(),()=>connection.sent);
  const voiceRequest=requests.at(-1)!;expect(voiceRequest.posture).toBe("voice");expect(voiceRequest.workerSandbox?.noteFacts?.history,"HOST_VOICE_JOURNAL_NOT_REVERT_AUTHORITY").toEqual({journal:true,userRevert:false});expect(workerSandboxNote(voiceRequest.workerSandbox!)).toContain("User history restoration is unavailable for this turn");connection.close();
  for(const withJournal of [true,false]) {const host=new WsHost({brainPath:brain,registry,catalog:app.wsHost.catalog,governedTurns:app.wsHost.governedTurns,...(withJournal?{journal:app.wsHost.journal}: {})});extraHosts.push(host);const request=await chat(host);expect(request.workerSandbox?.noteFacts?.history,"HOST_MISSING_SERVICE_NEVER_PROMISES_REVERT").toEqual({journal:withJournal,userRevert:false});const note=workerSandboxNote(request.workerSandbox!);expect(note).toContain(withJournal?"Host change journaling is active":"Host change journaling is unavailable");expect(note).not.toContain("User history can revert");}
 }finally{for(const host of extraHosts)host.close();await app.close();await rm(root,{recursive:true,force:true});}
},30000);
