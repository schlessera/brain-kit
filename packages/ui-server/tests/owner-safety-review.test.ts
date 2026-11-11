import { expect, test } from "bun:test";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";
import type { SafetyPage } from "@schlessera/brain-ui-sdk/protocol";
import { createPrincipal, revokePrincipal } from "../src/db/principals";
import * as account from "../src/db/account-writes";
import * as held from "./fixtures/held-publication-writer";
import * as races from "./fixtures/owner-review-races";
import { occurrence } from "../src/governance/occurrence";
import { openDialogue, bindDialogue } from "../src/ws/dialogue-storage";
import { retireChat } from "../src/ws/chat-lifecycle";
import { OwnerSafetyReviews } from "../src/governance/owner-safety-reviews";
import * as reviewClock from "./fixtures/safety-review-clock";
import * as slowWriter from "./fixtures/write-worker-probe";
import type { SafetyReviewReceipt } from "../src/governance/safety-reviews";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../src/app-env";
import { authGuard } from "../src/middleware/auth";
import { createAccountPartitionKeys } from "../src/middleware/account-partition";
import { createOwnerSafetyReviewRoutes } from "../src/routes/owner-safety-review";

type Fixture = Awaited<ReturnType<typeof safetyHistoryFixture>>;
const origin = (f: Fixture) => new URL(f.url.replace("ws:","http:")).origin;
function post(f: Fixture, suffix: string, body: unknown, overrides: Record<string,string|null> = {}) {
  const headers = new Headers({cookie:f.cookie,"content-type":"application/json",origin:origin(f)});
  for (const [key,value] of Object.entries(overrides)) { if (value === null) headers.delete(key); else headers.set(key,value); }
  return fetch(`${origin(f)}/api/sessions/ithaca/safety/reviews${suffix}`,{method:"POST",headers,body:JSON.stringify(body)});
}
function bodyFor(f: Fixture, id: string) {
  const state = f.writes.safety(null,"ithaca");
  return {version:1 as const,session:state.session!,occurrenceId:id,expectedEvidenceRevision:state.evidenceRevision,verdict:"safe" as const};
}
async function prepared(f: Fixture, id: string) {
  const body = bodyFor(f,id), response = await post(f,"/prepare",body);
  expect(response.status,"OWNER_REVIEW_PREPARE_TARGET_IS_ELIGIBLE").toBe(200);
  return {body,handle:(await response.json()).receipt.requestId as string};
}
async function hold(f: Fixture) {
  const channel = f.writer.channel(held,undefined); await channel.ready;
  expect(await channel.call<number>("level")).toBe(2);
  const entered = new Int32Array(new SharedArrayBuffer(4)), release = new Int32Array(new SharedArrayBuffer(4));
  const pending = channel.call("hold",entered,release), wait = Atomics.waitAsync(entered,0,0,5000);
  if (wait.async) await wait.value;
  expect(Atomics.load(entered,0)).toBe(1);
  return {pending,release(){Atomics.store(release,0,1);Atomics.notify(release,0);}};
}
function count(f: Fixture) { return (f.db.query("SELECT COUNT(*) n FROM safety_decisions").get() as {n:number}).n; }

test("a signed owner reviews only A and exact replay preserves its fact after later B/C", async () => {
  const f = await safetyHistoryFixture(true, true);
  const post = (suffix: string, body: unknown) => fetch(f.url.replace("ws:", "http:").replace("/ws", `/api/sessions/ithaca/safety/reviews${suffix}`), {
    method: "POST", headers: { cookie: f.cookie, "content-type": "application/json", origin: f.url.replace("ws:", "http:").replace("/ws", "") }, body: JSON.stringify(body),
  });
  try {
    const a = await f.add("A");
    const page = await (await f.get()).json() as SafetyPage;
    const body = { version: 1, session: page.identity, occurrenceId: a.id, expectedEvidenceRevision: page.projection.evidenceRevision, verdict: "safe" };
    const prepared = await post("/prepare", body);
    expect(prepared.status, "OWNER_REVIEW_PREPARE_REACHES_REAL_HTTP").toBe(200);
    const handle = (await prepared.json()).receipt.requestId;
    const committed = await post(`/${handle}/commit`, body);
    expect(committed.status).toBe(200);
    const first = await committed.json();
    expect(first.receipt.verdict).toBe("committed");
    expect(first.currentProjection.restriction).toBe("normal");
    await f.add("B"); await f.add("C");
    const retry = await (await post(`/${handle}/commit`, body)).json();
    expect(retry.receipt, "OWNER_REVIEW_REPLAY_IS_THE_ORIGINAL_DURABLE_FACT").toEqual(first.receipt);
    expect(retry.currentProjection.unresolvedCount, "OWNER_REVIEW_A_NEVER_RESOLVES_LATER_B_C").toBe(2);
    expect(retry.currentProjection.restriction).toBe("restricted");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("owner mutation requires a present matching Origin and bounded exact JSON", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const body = bodyFor(f,(await f.add("A")).id);
    const rejectedHeaders: Record<string,string|null>[] = [
      {origin:null}, {origin:"null"}, {origin:"https://troy.invalid"},
      {origin:"https://troy.invalid","sec-fetch-site":"same-origin"}, {"content-type":"text/plain"},
    ];
    for (const headers of rejectedHeaders) expect((await post(f,"/prepare",body,headers)).status,"OWNER_REVIEW_ORIGIN_AND_JSON_REQUIRED").toBe(headers["content-type"] ? 415 : 403);
    for (const extra of [{principalId:f.principal.id},{channel:"owner_history"},{channel:"card"},{voice:true},{rule:{}},{throughSequence:"99"},{occurrenceIds:[body.occurrenceId]}]) {
      expect((await post(f,"/prepare",{...body,...extra})).status,"OWNER_REVIEW_REJECTS_CALLER_AUTHORITY_AND_BULK_CLEAR").toBe(400);
    }
    expect((await post(f,"/prepare",{...body,session:{...body.session,sessionId:"other"}})).status).toBe(400);
    expect((await post(f,"/prepare",{...body,padding:"x".repeat(16385)})).status).toBe(413);
    expect((await post(f,"/prepare",body,{cookie:null})).status).toBe(401);
    expect(count(f)).toBe(0);
    expect(f.db.query("SELECT COUNT(*) n FROM safety_review_requests").get()).toEqual({n:0});
  } finally { await f.close(); }
});

test("signed delegated cookies and owner cookies on another account's history cannot mutate it", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const body = bodyFor(f,(await f.add("A")).id);
    const agent = createPrincipal(f.db,{authMethod:"delegated",createdBy:f.principal.id,label:"Telemachus",ttlSeconds:3600});
    const otherLogin = createPrincipal(f.db,{authMethod:"password",label:"Odysseus at Ithaca",ttlSeconds:3600});
    expect((await post(f,"/prepare",body,{cookie:await f.cookieFor(agent)})).status,"OWNER_REVIEW_DELEGATION_IS_NOT_HUMAN_AUTHORITY").toBe(403);
    // Every password login is the one owner: another device's login reviews the chat (#3952).
    expect((await post(f,"/prepare",body,{cookie:await f.cookieFor(otherLogin)})).status,"OWNER_REVIEW_ANOTHER_LOGIN_IS_THE_SAME_ACCOUNT").toBe(200);
    // A history bound to another account stays unavailable to every owner login.
    f.db.query("UPDATE safety_sessions SET principal_id=? WHERE session_id='ithaca'").run(agent.id);
    for (const cookie of [f.cookie, await f.cookieFor(otherLogin)]) {
      const denied = await post(f,"/prepare",body,{cookie});
      expect(denied.status,"OWNER_REVIEW_FOREIGN_ACCOUNT_HISTORY").toBe(404);
      expect(await denied.json()).toEqual({code:"unavailable",reason:"unavailable",retryable:false});
    }
    f.db.query("UPDATE safety_sessions SET principal_id=? WHERE session_id='ithaca'").run(f.principal.id);
    const {handle} = await prepared(f,body.occurrenceId);
    revokePrincipal(f.db,f.principal.id,Date.now());
    expect((await post(f,`/${handle}/commit`,body)).status,"OWNER_REVIEW_REVOKED_COOKIE_CANNOT_COMMIT").toBe(401);
    expect(count(f)).toBe(0);
  } finally { await f.close(); }
});

for (const mode of ["none","proxy","tailscale"] as const) test(`${mode} remains read only through the real auth middleware`, async () => {
  const f = await safetyHistoryFixture(true,true,mode);
  try {
    const body = bodyFor(f,(await f.add("A")).id);
    const response = await post(f,"/prepare",body,{"x-user":"Odysseus","x-forwarded-for":"100.64.0.1"});
    expect(response.status,"OWNER_REVIEW_AMBIENT_MODES_NEVER_MUTATE").toBe(403);
    expect(count(f)).toBe(0);
    expect(f.reviews!.capabilities(f.principal)).toMatchObject({review:false,readOnlyReason:"owner_required"});
  } finally { await f.close(); }
});

test("real WS advertises live owner capability, delivers verdict deltas and rejects forged mutation frames", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const a = await f.add("A"), socket = await f.connect();
    expect(socket.hello).toMatchObject({type:"server_hello",safetyCapabilities:{review:true,readOnlyReason:null,originRules:false}});
    const agent = createPrincipal(f.db,{authMethod:"delegated",createdBy:f.principal.id,label:"Telemachus",ttlSeconds:3600});
    expect((await f.connect(await f.cookieFor(agent))).hello).toMatchObject({safetyCapabilities:{review:false,readOnlyReason:"owner_required"}});
    socket.send({type:"safety_commit",channel:"owner_history",principalId:f.principal.id,occurrenceId:a.id,verdict:"safe"});
    socket.send({type:"ping",probeId:"forged-mutation-barrier"}); await socket.until(m=>m.type==="pong");
    expect(count(f),"OWNER_REVIEW_NO_MODEL_OR_VOICE_FRAME_AUTHORITY").toBe(0);
    socket.send({type:"safety_read",version:1,requestId:"initial",target:{sessionId:"ithaca"}});
    const frame = await socket.until(m=>m.type==="safety_history");
    if (frame.type !== "safety_history") throw new Error("Missing safety history");
    socket.send({type:"safety_subscribe",version:1,requestId:"live",identity:frame.page.identity,afterRevision:frame.page.highWater,snapshotId:frame.page.snapshotId});
    socket.send({type:"ping",probeId:"subscribed"}); await socket.until(m=>m.type==="pong");
    const {body,handle} = await prepared(f,a.id);
    expect((await post(f,`/${handle}/commit`,body)).status).toBe(200);
    f.history.poll();
    const update = await socket.until(m=>m.type==="safety_update");
    expect(update).toMatchObject({update:{projection:{unresolvedCount:0,restriction:"normal"},records:[{kind:"safe_decision",occurrenceId:a.id}]}});
    expect(f.starts()).toBe(0);
  } finally { await f.close(); }
});

test("open and unknown exposure refuse until a proved finalization, regardless of client verdict", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    let openId = "";
    for (const state of ["open","interrupted_unknown"] as const) {
      const o = occurrence(f.bindingId,"tool_web_input",state,state);
      if(state === "open")openId=o.id;
      await f.writes.record({kind:"taint",turnId:"voyage",sessionId:"ithaca",actor:"interactive",model:null,profile:"governed",payload:{source:"web_fetch",tool:"WebFetch",detail:null,occurrence:o}});
      const response = await post(f,"/prepare",bodyFor(f,o.id));
      expect(response.status,"OWNER_REVIEW_NONFINAL_INPUT_REFUSES_PREPARATION").toBe(409);
      expect((await response.json()).receipt).toMatchObject({reason:"not_finalized",projection:null,verdict:"unresolved"});
    }
    expect(count(f)).toBe(0);
    expect(f.writes.safety(null,"ithaca").unresolvedCount).toBe(2);
    await f.writes.record({kind:"taint_exposure",turnId:"voyage",sessionId:"ithaca",actor:"interactive",model:null,profile:"governed",payload:{occurrenceId:openId,state:"finalized"}});
    const p = await prepared(f,openId);
    expect((await post(f,`/${p.handle}/commit`,p.body)).status).toBe(200);
    expect(f.writes.safety(null,"ithaca").unresolvedCount).toBe(1);
  } finally { await f.close(); }
});

test("SQLite retains finalized, principal and generation fences beneath the public transport", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const open = occurrence(f.bindingId,"tool_web_input","open","open");
    await f.writes.record({kind:"taint",turnId:"voyage",sessionId:"ithaca",actor:"interactive",model:null,profile:"governed",payload:{source:"web_fetch",tool:"WebFetch",detail:null,occurrence:open}});
    const a = await f.add("A"), session = f.writes.safety(null,"ithaca").session!;
    const insert = f.db.query("INSERT INTO safety_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const attempt = (id:string,principal:string,generation:string)=>()=>insert.run(crypto.randomUUID(),id,"ithaca",session.historyOwnerId,generation,"1000000",principal,crypto.randomUUID(),Date.now(),"safe","owner_history");
    expect(attempt(open.id,f.principal.id,session.historyGeneration),"OWNER_REVIEW_SQL_FINALIZED_BACKSTOP").toThrow("safety decision identity or exposure mismatch");
    expect(attempt(a.id,"foreign-owner",session.historyGeneration),"OWNER_REVIEW_SQL_PRINCIPAL_BACKSTOP").toThrow("safety decision identity or exposure mismatch");
    expect(attempt(a.id,f.principal.id,"2"),"OWNER_REVIEW_SQL_GENERATION_BACKSTOP").toThrow("safety decision identity or exposure mismatch");
    expect(count(f)).toBe(0);
  } finally { await f.close(); }
});

test("request capacity refuses fresh preparation while prepaid retained verdicts remain usable", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const a = await f.add("A"), handles: Awaited<ReturnType<typeof prepared>>[] = [];
    for(let i=0;i<32;i++)handles.push(await prepared(f,a.id));
    const refused = await post(f,"/prepare",handles[0]!.body);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({code:"capacity",reason:"capacity",retryable:false,receipt:{stage:"refused",projection:null}});
    const p = handles[0]!;
    expect((await post(f,`/${p.handle}/commit`,p.body)).status).toBe(200);
    expect(count(f)).toBe(1);
    expect(f.db.query("SELECT COUNT(*) n FROM safety_review_requests").get()).toEqual({n:32});
  } finally { await f.close(); }
});

test("new B/C between prepare and commit force a fresh review of A and leave B/C unresolved", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const a = await f.add("A"), stale = await prepared(f,a.id);
    await f.add("B"); await f.add("C");
    const refused = await (await post(f,`/${stale.handle}/commit`,stale.body)).json();
    expect(refused.receipt,"OWNER_REVIEW_STALE_PREPARE_CANNOT_RESOLVE").toMatchObject({reason:"stale_revision",projection:null,verdict:"unresolved"});
    expect(count(f)).toBe(0);
    const fresh = await prepared(f,a.id);
    const result = await (await post(f,`/${fresh.handle}/commit`,fresh.body)).json();
    expect(result.receipt.verdict).toBe("committed");
    expect(result.currentProjection).toMatchObject({restriction:"restricted",unresolvedCount:2});
  } finally { await f.close(); }
});

test("unknown handles, conflicting retries and changed authority never mint another decision", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const a = await f.add("A"), b = await f.add("B"), p = await prepared(f,a.id);
    expect((await (await post(f,"/unknown/commit",p.body)).json()).receipt.reason).toBe("unavailable");
    expect((await (await post(f,`/${p.handle}/commit`,{...p.body,occurrenceId:b.id})).json()).receipt.reason).toBe("request_conflict");
    f.db.query("UPDATE principals SET expires_at=expires_at+1000 WHERE id=?").run(f.principal.id);
    expect((await (await post(f,`/${p.handle}/commit`,p.body)).json()).receipt.reason,"OWNER_REVIEW_PREPARED_HANDLE_BINDS_AUTH_EPOCH").toBe("request_conflict");
    expect(count(f)).toBe(0);
  } finally { await f.close(); }
});

for (const action of ["prepare","commit"] as const) test(`revocation in the FULL queue fences ${action} at its transaction`, async () => {
  const f = await safetyHistoryFixture(true,true);
  let barrier: Awaited<ReturnType<typeof hold>> | undefined;
  try {
    const a = await f.add("A"), p = action === "commit" ? await prepared(f,a.id) : {body:bodyFor(f,a.id),handle:""};
    await f.get(); await f.writer.idle();
    const admin = f.writer.channel(account,undefined); await admin.ready;
    barrier = await hold(f);
    const revocation = admin.call("revokePrincipal",f.principal.id,Date.now());
    const submitted = Promise.withResolvers<void>();
    const name = action === "commit" ? "safetyCommitReview" : "safetyPrepareReview";
    const original = f.writes[name].bind(f.writes);
    // Observe submission after real cookie/body admission, not a mocked writer.
    Object.assign(f.writes,{[name]:(...args: Parameters<typeof original>)=>{const result=Reflect.apply(original,f.writes,args);submitted.resolve();return result;}});
    const response = post(f,action === "commit" ? `/${p.handle}/commit` : "/prepare",p.body);
    await submitted.promise;
    expect(count(f)).toBe(0); barrier.release(); await barrier.pending; await revocation;
    expect((await response).status,"OWNER_REVIEW_QUEUED_AUTHORITY_RECHECK").toBe(403);
    expect(count(f),"OWNER_REVIEW_REVOKED_QUEUED_REQUEST_HAS_NO_EFFECT").toBe(0);
  } finally { barrier?.release(); await f.close(); }
});

for (const change of ["expiry","retirement"] as const) test(`${change} while the real commit is queued leaves no verdict`, async () => {
  const f = await safetyHistoryFixture(true,true);
  let barrier: Awaited<ReturnType<typeof hold>> | undefined;
  try {
    const p = await prepared(f,(await f.add("A")).id), control = f.writer.channel(races,undefined); await control.ready;
    barrier = await hold(f);
    const changed = change === "expiry" ? control.call("expire",f.principal.id,Date.now()-1) : control.call("retire",{
      operationId:"retire-voyage",principalId:f.principal.id,target:{sessionId:"ithaca"},expected:{backendId:"claude",generation:1},removableBackends:["claude"],at:Date.now(),
    });
    const submitted = Promise.withResolvers<void>(), original = f.writes.safetyCommitReview.bind(f.writes);
    f.writes.safetyCommitReview = (...args)=>{const result=original(...args);submitted.resolve();return result;};
    const response = post(f,`/${p.handle}/commit`,p.body); await submitted.promise;
    expect(count(f)).toBe(0); barrier.release(); await barrier.pending; await changed;
    expect((await response).status,"OWNER_REVIEW_QUEUED_EXPIRY_AND_RETIREMENT_FENCE").toBe(change === "expiry" ? 403 : 404);
    expect(count(f)).toBe(0);
  } finally { barrier?.release(); await f.close(); }
});

test("a failed FULL verdict transaction never reports success or loosens admission", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const p = await prepared(f,(await f.add("A")).id);
    f.db.exec("CREATE TRIGGER refuse_verdict BEFORE INSERT ON safety_decisions BEGIN SELECT RAISE(ABORT,'Odysseus refuses the verdict'); END");
    expect((await post(f,`/${p.handle}/commit`,p.body)).status).toBe(404);
    expect(count(f)).toBe(0);
    expect(f.writes.safety(null,"ithaca")).toMatchObject({restriction:"restricted",unresolvedCount:1});
    expect(f.db.query("SELECT terminal_at FROM safety_review_requests WHERE id=?").get(p.handle)).toEqual({terminal_at:null});
  } finally { await f.close(); }
});

for (const change of ["revocation","retirement","recording-loss","new-input"] as const) test(`final HTTP delivery fences ${change} after the service wait`, async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const p = await prepared(f,(await f.add("A")).id), original = f.reviews!.review.bind(f.reviews);
    f.reviews!.review = async (...args)=>{
      const response = await original(...args);
      if (change === "revocation") revokePrincipal(f.db,f.principal.id,Date.now());
      if (change === "retirement") retireChat(f.db,{operationId:"delivery-retire",principalId:f.principal.id,target:{sessionId:"ithaca"},expected:{backendId:"claude",generation:1},removableBackends:["claude"],at:Date.now()});
      if (change === "recording-loss") await f.writes.safetyFail("voyage");
      if (change === "new-input") await f.add("B");
      return response;
    };
    const response = await post(f,`/${p.handle}/commit`,p.body);
    expect(response.status,"OWNER_REVIEW_FINAL_HTTP_AUTHORITY_FENCE").toBe(change === "revocation" ? 403 : change === "retirement" ? 404 : 200);
    if (response.status === 200) {
      const result = await response.json();
      expect(result.receipt.projection.restriction).toBe("normal");
      expect(result.currentProjection.restriction,"OWNER_REVIEW_FINAL_AGGREGATE_NEVER_REPLAYS_OLD_NORMAL").toBe("restricted");
    }
    expect(count(f)).toBe(1);
  } finally { await f.close(); }
});

test("canonical history can review an adopted provisional occurrence before its collection rebind", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    openDialogue(f.db,{conversationId:"target-voice",principalId:f.principal.id,epoch:1,providerId:"voice",sessionId:"ithaca"});
    const owner = openDialogue(f.db,{conversationId:"scout-voice",principalId:f.principal.id,epoch:1,providerId:"voice"});
    await f.writes.safetyBegin({turnId:"scout-turn",bindingId:"scout-binding",sessionId:null,principalId:f.principal.id,backendId:"claude",historyOwnerId:owner.id,at:0});
    await f.writes.safetyReady("scout-turn","claude",1);
    const c = occurrence("scout-binding","tool_web_input","C","finalized");
    await f.writes.record({kind:"taint",turnId:"scout-turn",sessionId:null,actor:"interactive",model:null,profile:"governed",payload:{source:"web_fetch",tool:"WebFetch",detail:null,occurrence:c}});
    bindDialogue(f.db,"scout-voice",f.principal.id,"ithaca");
    expect(f.writes.safety(null,"ithaca").unresolvedCount).toBe(1);
    const p = await prepared(f,c.id), response = await post(f,`/${p.handle}/commit`,p.body);
    expect(response.status,"OWNER_REVIEW_CANONICAL_MEMBERSHIP_INCLUDES_ADOPTED_OCCURRENCE").toBe(200);
    expect(count(f)).toBe(1);
    expect(f.db.query("SELECT occurrence_id,session_id FROM safety_decisions").get()).toEqual({occurrence_id:c.id,session_id:"ithaca"});
  } finally { await f.close(); }
});

test("a password-mode passkey owner can review and a fresh service replays durable receipts", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    f.db.query("INSERT INTO passkey_credentials(id,public_key,counter,rp_id,backed_up,label,created_at) VALUES('odysseus-bow',?,0,'ithaca.invalid',0,'Odysseus',?)").run(new Uint8Array([1,2,3]),Date.now());
    f.db.query("UPDATE principals SET auth_method='passkey',credential_id='odysseus-bow' WHERE id=?").run(f.principal.id);
    const a = await f.add("A"), p = await prepared(f,a.id);
    const first = await (await post(f,`/${p.handle}/commit`,p.body)).json();
    expect(first.receipt.verdict,"OWNER_REVIEW_PASSKEY_IS_HUMAN_OWNER_AUTHORITY").toBe("committed");
    const current = (await import("../src/db/principals")).resolvePrincipal(f.db,f.principal.id)!;
    const restarted = new OwnerSafetyReviews(f.db,f.writes,"password",f.brainKey);
    const replay = await restarted.review(current,p.body,p.handle);
    expect(replay.receipt).toEqual(first.receipt);
    expect(count(f)).toBe(1);
  } finally { await f.close(); }
});

test("a prepared browser handle expiring behind a FULL transaction cannot commit", async () => {
  const f = await safetyHistoryFixture(true,true);
  try {
    const a = await f.add("A"), body = bodyFor(f,a.id), clock = f.writer.channel(reviewClock,undefined), slow = f.writer.channel(slowWriter,{table:"review_expiry_hold"});
    await clock.ready; await slow.ready;
    const {id,kind,authMethod,credentialId,createdAt,expiresAt} = f.principal;
    const actor = {principalId:id,channel:"owner_history" as const,authority:{id,kind,authMethod,credentialId,createdAt,expiresAt,brainKey:f.brainKey}};
    const issuedAt = Date.now()-899000;
    const handle = (await clock.call<SafetyReviewReceipt>("safetyPrepareReview",body,actor,issuedAt)).requestId!;
    await f.get(); await f.writer.idle();
    const entered = new Int32Array(new SharedArrayBuffer(4));
    const holding = slow.call("slow","Odysseus",1400,entered), wait = Atomics.waitAsync(entered,0,0,5000);
    if(wait.async)await wait.value;
    expect(Atomics.load(entered,0)).toBe(1);
    const submitted = Promise.withResolvers<number>(), original = f.writes.safetyCommitReview.bind(f.writes);
    f.writes.safetyCommitReview = (...args)=>{const result=original(...args);submitted.resolve(Date.now());return result;};
    const response = post(f,`/${handle}/commit`,body);
    expect(await submitted.promise).toBeLessThan(issuedAt+900000);
    expect(count(f)).toBe(0); await holding;
    expect((await response).status).toBe(409);
    const stored = f.db.query("SELECT receipt FROM safety_review_requests WHERE id=?").get(handle) as {receipt:string};
    expect(JSON.parse(stored.receipt).reason,"OWNER_REVIEW_EXPIRY_USES_ACQUIRED_TRANSACTION_CLOCK").toBe("request_expired");
    expect(count(f)).toBe(0);
  } finally { await f.close(); }
});

test("a second authenticated brain root sharing the database cannot commit or replay the first root's handle", async () => {
  const f = await safetyHistoryFixture(true,true);
  let second: ReturnType<typeof Bun.serve> | undefined;
  try {
    const p = await prepared(f,(await f.add("A")).id), otherRoot = join(f.root,"troy"); mkdirSync(otherRoot);
    const otherKey = createAccountPartitionKeys(f.db,otherRoot,"password")(f.principal)!;
    expect(otherKey).not.toBe(f.brainKey);
    const app = new Hono<AppEnv>();app.use("/api/*",authGuard("password",f.auth,f.db));
    app.route("/api",createOwnerSafetyReviewRoutes(new OwnerSafetyReviews(f.db,f.writes,"password",otherKey),false));
    second = Bun.serve({hostname:"127.0.0.1",port:0,fetch:app.fetch});
    const retry = ()=>fetch(`${second!.url.origin}/api/sessions/ithaca/safety/reviews/${p.handle}/commit`,{
      method:"POST",headers:{cookie:f.cookie,origin:second!.url.origin,"content-type":"application/json"},body:JSON.stringify(p.body),
    });
    const denied = await retry();
    expect(denied.status,"OWNER_REVIEW_HANDLE_BINDS_THE_SERVED_BRAIN_ROOT").toBe(409);
    expect((await denied.json()).receipt.reason).toBe("request_conflict");expect(count(f)).toBe(0);
    expect((await post(f,`/${p.handle}/commit`,p.body)).status).toBe(200);
    const replay = await retry();
    expect(replay.status).toBe(409);expect((await replay.json()).receipt.projection).toBeNull();expect(count(f)).toBe(1);
  } finally {second?.stop(true);await f.close();}
});

test("delayed verdicts remain restrictive and resolving known evidence never repairs a coverage gap", async () => {
  const f = await safetyHistoryFixture(true,true);
  let barrier: Awaited<ReturnType<typeof hold>> | undefined;
  try {
    f.db.query("UPDATE safety_collections SET gap='unobserved_history' WHERE turn_id='voyage'").run();
    const p = await prepared(f,(await f.add("A")).id);
    barrier = await hold(f);
    const submitted = Promise.withResolvers<void>(), original = f.writes.safetyCommitReview.bind(f.writes);
    f.writes.safetyCommitReview = (...args)=>{const result=original(...args);submitted.resolve();return result;};
    const response = post(f,`/${p.handle}/commit`,p.body); await submitted.promise;
    expect(count(f)).toBe(0);
    expect(f.writes.taint(null,"ithaca"),"OWNER_REVIEW_PENDING_VERDICT_NEVER_LOOSENS_ADMISSION").not.toBeNull();
    barrier.release(); await barrier.pending;
    const committed = await (await response).json();
    expect(committed.receipt.verdict).toBe("committed");
    expect(committed.currentProjection).toMatchObject({unresolvedCount:0,restriction:"restricted",coverage:{state:"incomplete"}});
    expect(f.writes.taint(null,"ithaca")).not.toBeNull();
  } finally { barrier?.release(); await f.close(); }
});
