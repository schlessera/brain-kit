/** Declared IPC routing only; never starts an installed runtime. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { nativeAdmittedRelayBaseUrl, nativeScriptedService } from "../scripts/test-native-guard";
import { startInferenceRelay } from "../packages/ui-sdk/src/server/inference-relay";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";

test("admitted custom base path reaches the exact real Unix relay route",async()=>{
 const service=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){return Response.json({path:new URL(request.url).pathname});}});
 const leave=nativeScriptedService(service.url.origin),upstream=service.url.origin+"/anthropic";
 const relay=startInferenceRelay({upstream,routes:["/v1/messages"],credentials:{authorization:"Bearer odysseus-fixture"}});
 try{
  const base=nativeAdmittedRelayBaseUrl("http://localhost/anthropic",true);
  const response=await fetch(base+"/v1/messages",{unix:relay.socketPath,method:"POST",body:"{}"});
  expect(response.status,"ADMITTED_CUSTOM_RELAY_PATH_REACHES_MODEL").toBe(200);
  expect(await response.json()).toEqual({path:"/anthropic/v1/messages"});
  expect((await fetch("http://localhost/v1/messages",{unix:relay.socketPath,method:"POST",body:"{}"})).status).toBe(403);
  expect(nativeAdmittedRelayBaseUrl(upstream,false),"FALLBACK_RELAY_STAYS_AT_ROOT").toBe("http://localhost");
  expect(nativeAdmittedRelayBaseUrl("https://gateway.ithaca.invalid/Anthropic%20Route",true)).toBe("http://localhost/Anthropic%20Route");
 }finally{relay.stop();leave();service.stop(true);}
});

for(const [name,path] of Object.entries({dot:"/a/../anthropic",singleDot:"/a/./anthropic",encodedDot:"/%2e%2E/anthropic",encodedSlash:"/anthropic%2fsecret",backslash:"/anthropic\\secret",encodedBackslash:"/anthropic%5csecret",query:"/anthropic?q=1",hash:"/anthropic#secret",trailingSlash:"/anthropic/",rootSlash:"/"}))test(`admitted relay refuses ${name} path without normalization`,async()=>{
 const guard=join(import.meta.dir,"../scripts/test-native-guard.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`import {nativeAdmittedRelayBaseUrl} from ${JSON.stringify(guard)};try{nativeAdmittedRelayBaseUrl(${JSON.stringify("http://localhost"+path)},true);}catch{}`],{env:{PATH:"/usr/bin:/bin"}});
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);
 expect(code,"NONCANONICAL_RELAY_PATH_MUST_REFUSE").not.toBe(0);expect(out).toContain("admitted relay base path is not canonical");
});

test("admitted relay refuses URL userinfo",async()=>{
 const guard=join(import.meta.dir,"../scripts/test-native-guard.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`import {nativeAdmittedRelayBaseUrl} from ${JSON.stringify(guard)};try{nativeAdmittedRelayBaseUrl("http://odysseus:fixture@localhost/anthropic",true);}catch{}`],{env:{PATH:"/usr/bin:/bin"}});
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);expect(code).not.toBe(0);expect(out).toContain("admitted relay base path is not canonical");
});
