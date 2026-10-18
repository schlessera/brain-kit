import {expect,spyOn,test} from "bun:test";
import {chromium} from "playwright";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as brainClient from "../src/brain/client.js";
import {httpContractApp} from "./helpers/http-contract-app.js";
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}

test("a native browser's held status belongs to its first app while the next app is healthy",async()=>{
 const state=mkdtempSync(join(tmpdir(),"odysseus-native-status-drain-")),entered=deferred(),release=deferred(),events:string[]=[];
 const original=brainClient.createBrainClient,capture=spyOn(brainClient,"createBrainClient").mockImplementation(options=>{
  const client=original(options),modules=client.modules!.bind(client);
  client.modules=async()=>{const result=await modules();events.push("first:module-result-ready");entered.resolve();await release.promise;events.push("first:module-result-released");return result;};return client;
 });
 let first:Awaited<ReturnType<typeof httpContractApp>>|undefined,second:Awaited<ReturnType<typeof httpContractApp>>|undefined;
 let server:ReturnType<typeof Bun.serve>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  first=await httpContractApp({env:{DB_PATH:join(state,"first.sqlite"),SOURCE_COMMIT:"a".repeat(40)},staticRoot:true});capture.mockRestore();
  server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:first.app.fetch,websocket:first.app.websocket});
  const origin=`http://127.0.0.1:${server.port}`,executablePath=["google-chrome-stable","google-chrome","chromium","chromium-browser"].map(name=>Bun.which(name)).find(Boolean);
  if(!executablePath)throw Error("Native HTTP shutdown proof requires real Chrome");
  browser=await chromium.launch({executablePath,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
  const context=await browser.newContext(),denied:string[]=[];
  await context.route("**/*",route=>{if(new URL(route.request().url()).origin===origin)return route.continue();denied.push(route.request().url());return route.abort();});
  await context.routeWebSocket("**/*",socket=>{denied.push(socket.url());socket.close();});
  const page=await context.newPage();await page.goto(origin);
  await page.evaluate(()=>{Object.assign(window,{heldStatus:fetch("/api/status").then(async response=>({status:response.status,body:await response.text()}))});});
  await entered.promise;events.push("first:close-requested");
  const closing=first.app.close().then(()=>{events.push("first:close-completed");});
  const refused=await page.evaluate(async()=>{const response=await fetch("/api/health");return response.status;});
  expect(refused,"NATIVE_CLOSING_APP_REFUSES_NEW_HTTP_DISPATCH").toBe(503);
  second=await httpContractApp({env:{DB_PATH:join(state,"second.sqlite"),SOURCE_COMMIT:"b".repeat(40)}});
  const next=await second.fetch("/api/status");expect(next.status,"SECOND_APP_STAYS_HEALTHY").toBe(200);expect((await next.json()).version).toBe("b".repeat(40));
  release.resolve();
  const result=await page.evaluate(()=>((window as unknown as {heldStatus:Promise<{status:number;body:string}>}).heldStatus));events.push(`first:response:${result.status}`);
  expect(result.status,"NATIVE_HELD_STATUS_MUST_NOT_RESUME_AFTER_ITS_OWNING_DATABASE_CLOSES").toBe(200);
  await closing;
  expect(events.indexOf("first:close-completed")).toBeGreaterThan(events.indexOf("first:module-result-released"));
  console.info("HTTP_SHUTDOWN_OWNER_SEQUENCE",JSON.stringify(events));expect(denied).toEqual([]);
 }finally{release.resolve();capture.mockRestore();await browser?.close();server?.stop(true);await second?.close();await first?.close();rmSync(state,{recursive:true,force:true});}
},30000);
