import { expect, test } from "bun:test";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import type { LocalWork } from "../src/lib/local-work.js";
import { createBrainApi } from "../src/lib/api-client.js";
import type { BrainApi } from "../src/lib/api-client.js";
import { updateHeld } from "../src/lib/update-holds.js";
import { TRACKER_STORAGE_KEY } from "../src/lib/trackers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function work(root: BrainUiRoot, resume: () => Promise<boolean>) {
  root.localWork = { snapshotNow: async () => {}, lock() {}, resume, dispose() {} } as LocalWork;
  root.stores.connection.getState().setVpnStatus("connected", "odysseus-key");
}
async function lock(root: BrainUiRoot) { await root.authLock.expire(); root.authLock.dropContext(); }

test("expiry during restoration invalidates completion and keeps context locked", async () => {
  const pending = deferred<boolean>(); const root = createBrainUiRoot({ storage: null });
  try {
    work(root, () => pending.promise); await lock(root);
    const restoring = root.authLock.signedIn("odysseus-key");
    await Promise.resolve(); await Promise.resolve();
    expect(root.authLock.state.getState().phase).toBe("restoring");
    await root.authLock.expire(); pending.resolve(true);
    expect(await restoring, "expired restore cannot activate protected views").toBe(false);
    expect(root.authLock.state.getState().phase).toBe("locked");
    expect(root.stores.connection.getState().accountKey).toBeNull();
    expect(updateHeld(root)).toBe(true);
  } finally { root.dispose(); }
});

test("overlapping same-account sign-ins restore once and install one manager", async () => {
  const pending=deferred<boolean>(); const root=createBrainUiRoot({storage:null}); let reads=0;
  try {
    work(root,()=>{ reads++; return pending.promise; }); await lock(root);
    const first=root.authLock.signedIn("odysseus-key"); const second=root.authLock.signedIn("odysseus-key");
    await Promise.resolve(); await Promise.resolve();
    expect(reads,"one account context read during overlapping completions").toBe(1);
    expect(first,"one shared restoration promise").toBe(second);
    pending.resolve(true); expect(await first).toBe(true); expect(await second).toBe(true);
    expect(root.authLock.state.getState().phase).toBe("active");
  } finally {root.dispose();}
});

test("a delayed 401 from an old authentication lifetime cannot expire the new one", async()=>{
 const pending=deferred<Response>(); const root=createBrainUiRoot({storage:null,request:()=>pending.promise});
 try {
  work(root,async()=>true); const stale=root.request("/api/sessions").catch(error=>error);
  await lock(root); expect(await root.authLock.signedIn("odysseus-key")).toBe(true);
  pending.resolve(new Response(null,{status:401}));
  expect((await stale).name,"stale auth evidence refused").toBe("AbortError");
  expect(root.authLock.state.getState().phase,"fresh account remains active").toBe("active");
 } finally {root.dispose();}
});

test("a body decoding and an injected API resolving after expiry cannot repopulate stores",async()=>{
 const body=deferred<string>(); const apiResult=deferred<{sessions:unknown[]}>();
 const api={sessions:()=>apiResult.promise} as unknown as BrainApi;
 const root=createBrainUiRoot({storage:null,api,request:async()=>Object.assign(new Response(),{json:async()=>JSON.parse(await body.promise)})});
 try {
  work(root,async()=>true);
  const response=await root.request("/api/sessions"); const reading=response.json().catch(e=>e);
  const injected=root.api.sessions().catch(e=>e);
  await lock(root); body.resolve(JSON.stringify({title:"Winds of Aeolus"})); apiResult.resolve({sessions:[{title:"Winds of Aeolus"}]});
  expect((await reading).name,"late response body refused").toBe("AbortError");
  expect((await injected).name,"late injected API payload refused").toBe("AbortError");
 } finally {root.dispose();}
});

test("lock clears activity read caches; restoration refetches finished history and payloads",async()=>{
 let histories=0,payloads=0;
 const runId="odysseus-run",spanId="odysseus-tool";
 const span={spanId,runId,origin:"session",sessionId:"odysseus-ithaca",operation:"agent.turn",startedAt:1,endedAt:2,outcome:"success",attrs:{}};
 const api={activityRuns:async()=>{histories++;return{history:[{runId,detailPruned:false}]};},activityRun:async(_id:string,options?:unknown)=>{
  if(options)payloads++; return{runId,spans:[span],events:[],highWaterSeq:1};
 }} as unknown as BrainApi;
 const root=createBrainUiRoot({storage:null,api});
 try {
  work(root,async()=>true); await root.stores.activity.loadSessionActivityHistory("odysseus-ithaca"); await root.stores.activity.loadSpanPayloads(spanId);
  expect(Object.keys(root.stores.activity.getState().spans),"nonempty finished history before expiry").toEqual([runId]);
  await lock(root); expect(root.stores.activity.getState().spans).toEqual({});
  expect(updateHeld(root),"auth alone holds reload after account stores clear").toBe(true);
  expect(await root.authLock.signedIn("odysseus-key")).toBe(true);
  await root.stores.activity.loadSessionActivityHistory("odysseus-ithaca"); await root.stores.activity.loadSpanPayloads(spanId);
  expect(histories,"finished history reloaded after lock").toBe(2); expect(payloads,"tool payload refetched after lock").toBe(2);
  expect(Object.keys(root.stores.activity.getState().spans),"finished history restored").toEqual([runId]);
 } finally {root.dispose();}
});


test("classified recovery 401 from the injected real client locks auth",async()=>{
 const api=createBrainApi(()=>"/api",async()=>new Response(null,{status:401}));
 const root=createBrainUiRoot({storage:null,api});
 try {
  work(root,async()=>true); expect(await root.api.sessionRecovery("odysseus-ithaca")).toEqual({ok:false,reason:"unauthorized"});
  expect(root.authLock.state.getState().phase,"classified unauthorized is auth evidence").toBe("locked");
 } finally {root.dispose();}
});

test("only the exact account-confirmation route remains readable while locked",async()=>{
 const requests:string[]=[];
 const root=createBrainUiRoot({storage:null,request:async(url)=>{requests.push(url);return Response.json({accountKey:"odysseus-key"});}});
 try {
  work(root,async()=>true); await lock(root);
  await expect(root.request("/api/files?path=/api/vpn-check")).rejects.toMatchObject({name:"AbortError"});
  expect(requests,"a protected URL containing the probe name is never dispatched").toEqual([]);
  expect(await (await root.request("/api/vpn-check")).json(),"the actual confirmation route is available").toEqual({accountKey:"odysseus-key"});
 } finally {root.dispose();}
});

test("lock cannot reintroduce account metadata captured in a persisted boot state",async()=>{
 const session="odysseus-sirens";
 const data=new Map([
  ["brain-sessionId",session],
  ["brain-turn-retries",JSON.stringify({[session]:{requestId:"odysseus-request",failedTurnId:"odysseus-turn",state:"waiting"}})],
  [TRACKER_STORAGE_KEY,JSON.stringify({v:1,principalKey:"odysseus-principal",trackers:[{sessionId:session,requestId:"odysseus-request",turnId:"odysseus-turn",revision:1,leftAt:1,seen:null}]})],
 ]);
 const storage={getItem:(key:string)=>[...data].find(([suffix])=>key.endsWith(suffix))?.[1]??null,setItem(){},removeItem(){}} as unknown as Storage;
 const root=createBrainUiRoot({storage});
 try {
  expect(Object.keys(root.stores.trackers.getState().records),"boot tracker fixture is nonempty").toEqual([session]);
  expect(Object.keys(root.stores.chat.getState().turnRetries)).toEqual([session]);
  expect(root.stores.chat.getState().activeSessionId).toBe(session);
  work(root,async()=>true); await lock(root);
  expect(root.stores.trackers.getState().records,"persisted trackers stay dropped after lock").toEqual({});
  expect(root.stores.trackers.getState().evidence).toEqual({});
  expect(root.stores.trackers.getState().principalKey).toBeNull();
  expect(root.stores.chat.getState().activeSessionId).toBeNull();
  expect(root.stores.chat.getState().turnRetries).toEqual({});
  expect(root.stores.trackers.getInitialState().records,"reset target also drops boot metadata").toEqual({});
 } finally {root.dispose();}
});


for(const invalidate of ["lock","dispose"] as const) test(`classified recovery remains a result after ${invalidate}`,async()=>{
 const pending=deferred<Response>(); let calls=0;
 const api=createBrainApi(()=>"/api",async()=>{calls++;return pending.promise;});
 const root=createBrainUiRoot({storage:null,api});
 try {
  work(root,async()=>true);
  const read=root.api.sessionRecovery("odysseus-ithaca").then(result=>({result}),error=>({error}));
  expect(calls,"the recovery read really started").toBe(1);
  if(invalidate === "lock") await lock(root); else root.dispose();
  pending.resolve(new Response(null,{status:401}));
  expect(await read,"classified recovery remains a result after invalidation").toEqual({result:{ok:false,reason:"host_unreachable"}});
  if(invalidate === "lock") expect(await root.api.sessionRecovery("odysseus-ithaca"),"locked recovery is classified without a request").toEqual({ok:false,reason:"host_unreachable"});
  expect(calls).toBe(1);
 } finally {pending.resolve(new Response(null,{status:401}));root.dispose();}
});
