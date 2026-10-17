import {expect,spyOn,test} from "bun:test";
import * as brainClient from "../src/brain/client.js";
import {httpContractApp} from "./helpers/http-contract-app.js";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {RENDER_BODY_LIMIT_BYTES} from "../src/middleware/body-limit.js";

function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

test("in-flight status keeps its owning database until the module response settles",async()=>{
 const entered=deferred(),release=deferred(),original=brainClient.createBrainClient;
 const capture=spyOn(brainClient,"createBrainClient").mockImplementation(options=>{
  const client=original(options),modules=client.modules!.bind(client);
  client.modules=async()=>{try{const result=await modules();entered.resolve();await release.promise;return result;}catch(error){entered.reject(error);throw error;}};
  return client;
 });
 const state=mkdtempSync(join(tmpdir(),"odysseus-status-drain-"));
 let fixture:Awaited<ReturnType<typeof httpContractApp>>|undefined,server:ReturnType<typeof Bun.serve>|undefined;
 let pending:Promise<Response>|undefined;
 try{
  fixture=await httpContractApp({env:{SOURCE_COMMIT:"a".repeat(40),DB_PATH:join(state,"ui.sqlite")}});
  capture.mockRestore();
  server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:fixture.app.fetch,websocket:fixture.app.websocket});
  pending=fetch(`http://127.0.0.1:${server.port}/api/status`);
  await entered.promise;
  const closing=fixture.app.close();
  const refused=await fixture.fetch("/api/health");
  expect(refused.status,"CLOSING_APP_REFUSES_NEW_HTTP_DISPATCH").toBe(503);
  expect(()=>fixture!.app.db.query("SELECT 1").get(),"HELD_REQUEST_RETAINS_OPERATIONAL_STATE").not.toThrow();
  release.resolve();
  const response=await pending;
  expect(response.status,"HELD_STATUS_MUST_NOT_RESUME_AFTER_ITS_DATABASE_CLOSES").toBe(200);
  await closing;
  expect(()=>fixture!.app.db.query("SELECT 1").get()).toThrow();
 }finally{release.resolve();capture.mockRestore();await pending?.catch(()=>{});server?.stop(true);await fixture?.close();rmSync(state,{recursive:true,force:true});}
});

test("shutdown cancels an unfinished body without waiting for its producer cancel promise",async()=>{
 const state=mkdtempSync(join(tmpdir(),"odysseus-status-body-")),entered=deferred();
 let source!:ReadableStreamDefaultController<Uint8Array>,first=true,cancelled=false,renders=0;
 const body=new ReadableStream<Uint8Array>({
  start(controller){source=controller;},
  pull(controller){if(first){first=false;controller.enqueue(new TextEncoder().encode('{"content":'));return;}entered.resolve();return new Promise<void>(()=>{});},
  cancel(){cancelled=true;return new Promise<void>(()=>{});},
 });
 const renderer={async renderPng(){renders++;return Buffer.from("unused");},async renderPdf(){renders++;return Buffer.from("unused");}};
 let fixture:Awaited<ReturnType<typeof httpContractApp>>|undefined,pending:Promise<Response>|undefined,closing:Promise<void>|undefined;
 try{
  fixture=await httpContractApp({env:{DB_PATH:join(state,"ui.sqlite")},renderer});
  pending=Promise.resolve(fixture.app.fetch(new Request("http://localhost/api/render",{method:"POST",headers:{"content-type":"application/json"},body})));
  await entered.promise;
  closing=fixture.app.close();
  const outcome=await Promise.race([pending.then(response=>response.status),Bun.sleep(1500).then(()=>"still reading" as const)]);
  expect(outcome,"SHUTDOWN_DOES_NOT_WAIT_FOR_UNFINISHED_CLIENT_BODY").not.toBe("still reading");
  expect(cancelled,"SHUTDOWN_CANCELS_ORIGINAL_BODY_READER").toBe(true);
  expect(outcome).toBe(400);expect(renders).toBe(0);
  await closing;
 }finally{try{source.close();}catch{/* The successful cancellation already closed it. */}await pending?.catch(()=>{});await closing?.catch(()=>{});await fixture?.close();rmSync(state,{recursive:true,force:true});}
});

test("ordinary chunked JSON keeps its metadata and bytes through the real mounted parser",async()=>{
 const state=mkdtempSync(join(tmpdir(),"odysseus-status-body-bytes-"));let html="",cancelled=false;
 const bytes=new TextEncoder().encode(JSON.stringify({content:"<p>Penelope waits in Ithaca.</p>",contentType:"html",format:"png"}));
 const chunks=[bytes.slice(0,13),bytes.slice(13)];
 const body=new ReadableStream<Uint8Array>({pull(controller){const chunk=chunks.shift();if(chunk)controller.enqueue(chunk);else controller.close();},cancel(){cancelled=true;}},{highWaterMark:0});
 const renderer={async renderPng(options:{html:string}){html=options.html;return Buffer.from("fixture-render-bytes");},async renderPdf(){throw Error("Unexpected PDF branch");}};
 const fixture=await httpContractApp({env:{DB_PATH:join(state,"ui.sqlite")},renderer});
 try{
  const request=new Request("http://localhost/api/render",{method:"POST",headers:{"content-type":"application/json","x-fixture-input":"Odysseus"},body});
  const response=await fixture.app.fetch(request);
  expect(response.status).toBe(200);expect(await response.text()).toBe("fixture-render-bytes");expect(html).toContain("Penelope waits in Ithaca.");
  expect(request.headers.get("x-fixture-input")).toBe("Odysseus");expect(request.bodyUsed).toBe(true);expect(cancelled).toBe(false);
 }finally{await fixture.close();rmSync(state,{recursive:true,force:true});}
});

test("a route that declines a body never pre-reads the caller stream",async()=>{
 const state=mkdtempSync(join(tmpdir(),"odysseus-status-unread-body-"));let pulls=0;
 const body=new ReadableStream<Uint8Array>({pull(){pulls++;}},{highWaterMark:0});
 const fixture=await httpContractApp({env:{DB_PATH:join(state,"ui.sqlite")}});
 try{
  const response=await fixture.app.fetch(new Request("http://localhost/api/render",{method:"POST",headers:{"content-type":"application/json"},body}));
  expect(response.status).toBe(501);expect(pulls,"UNCONSUMED_REQUEST_BODY_IS_NOT_PRE_READ").toBe(0);
 }finally{await body.cancel();await fixture.close();rmSync(state,{recursive:true,force:true});}
});

test("shutdown releases a byte-cap cancellation wait while preserving its 413 response",async()=>{
 const state=mkdtempSync(join(tmpdir(),"odysseus-status-capped-body-")),cancelling=deferred(),releaseCancel=deferred();let renders=0,settled=false;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(RENDER_BODY_LIMIT_BYTES+1));},cancel(){cancelling.resolve();return releaseCancel.promise;}});
 const renderer={async renderPng(){renders++;return Buffer.from("unused");},async renderPdf(){renders++;return Buffer.from("unused");}};
 const fixture=await httpContractApp({env:{DB_PATH:join(state,"ui.sqlite")},renderer});let pending:Promise<Response>|undefined,closing:Promise<void>|undefined;
 try{
  pending=Promise.resolve(fixture.app.fetch(new Request("http://localhost/api/render",{method:"POST",headers:{"content-type":"application/json"},body}))).then(response=>{settled=true;return response;});
  await cancelling.promise;expect(settled,"ORDINARY_BYTE_CAP_STILL_WAITS_FOR_ITS_PRODUCER_CANCEL").toBe(false);
  closing=fixture.app.close();
  const outcome=await Promise.race([pending.then(response=>response.status),Bun.sleep(1500).then(()=>"still cancelling" as const)]);
  expect(outcome,"SHUTDOWN_DOES_NOT_WAIT_FOR_STALLED_PRODUCER_CANCEL").toBe(413);expect(renders).toBe(0);await closing;
 }finally{releaseCancel.resolve();await pending?.catch(()=>{});await closing?.catch(()=>{});await fixture.close();rmSync(state,{recursive:true,force:true});}
});
