
import { expect, test } from "bun:test";
import { DialogueJournal } from "../src/ws/dialogue";
import { createUiDb } from "../src/db/client";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { StorageSettlementIndeterminate } from "../src/db/settlement";
import { storageDeadlineClock } from "./helpers/storage-deadline-clock";
import type { DialogueEvidence } from "@schlessera/brain-ui-sdk/protocol";

const opening={conversationId:"ithaca",principalId:"odysseus",epoch:1,providerId:"gemini-live",sessionId:"voyage"};
const evidence=(id:string):Extract<DialogueEvidence,{kind:"voice"}>=>({kind:"voice",conversationId:id,epoch:1,providerId:"gemini-live",event:{kind:"unassigned_input_fragment",sequence:0,text:"The mast is ready.",timing:{kind:"unavailable"}}});
const checkpoint=()=>new Promise<void>(resolve=>setImmediate(resolve));
test("canonical owner drains collect distinct references and remain independent of unrelated archives",async()=>{
  const db=createUiDb(":memory:"),catalog=createSessionCatalog(()=>db);
  const pages:unknown[]=[],callbacks:boolean[]=[],journal=new DialogueJournal(catalog,p=>pages.push(p),()=>{});
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  const append=catalog.dialogueAppend!;
  catalog.dialogueAppend=async input=>{const record=await append(input);if(input.ownerId==="ithaca")await held;return record;};
  let clock:ReturnType<typeof storageDeadlineClock>|undefined;
  try{
    const first=(await journal.open(opening))!,second=(await journal.open({...opening,conversationId:"pylos"}))!;
    const other=(await journal.open({...opening,conversationId:"sparta",sessionId:"other-voyage"}))!;
    expect(first).not.toBe(second);expect(first.id).toBe(second.id);
    clock=storageDeadlineClock();
    journal.voice("pylos",evidence("pylos"),value=>callbacks.push(value));
    journal.voice("sparta",evidence("sparta"),value=>callbacks.push(value));
    let sharedDone=false;const shared=journal.settleOwner(first).then(()=>{sharedDone=true;},e=>e);
    await journal.settleOwner(other);await checkpoint();
    expect(sharedDone,"SAME_CANONICAL_ID_INCLUDES_OTHER_OBJECT_PENDING_WRITES").toBe(false);
    expect(callbacks,"UNRELATED_OWNER_DRAINS_WITHOUT_SHARED_WAIT").toEqual([true]);
    clock.expire();const outcome=await shared;
    expect(outcome).toBeInstanceOf(StorageSettlementIndeterminate);
    expect((journal as any).ownerPending.size,"REAL_PENDING_OWNER_STILL_OWNED").toBe(1);
    release();await journal.settled();
    expect(callbacks,"LATE_CANONICAL_CALLBACK_CANNOT_REENTER_LIVE_SCOPE").toEqual([true]);
    expect(pages).toHaveLength(1);
    expect((await catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.records).toHaveLength(1);
    expect((journal as any).ownerPending.size).toBe(0);
    expect((journal as any).queues.size).toBe(0);
  }finally{release();clock?.restore();await journal.settled();db.close();}
});
test("an expired queued opening never executes later or replaces a healthy opening",async()=>{
  const db=createUiDb(":memory:"),catalog=createSessionCatalog(()=>db),journal=new DialogueJournal(catalog,()=>{},()=>{});
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  const close=catalog.dialogueClose!;catalog.dialogueClose=async(...args)=>{await held;return close(...args);};
  let clock:ReturnType<typeof storageDeadlineClock>|undefined;
  try{
    await journal.open(opening);journal.close("ithaca","odysseus",1);clock=storageDeadlineClock();
    const next=journal.open({...opening,epoch:2}).catch(e=>e);clock.expire();
    expect(await next).toBeInstanceOf(StorageSettlementIndeterminate);
    release();await journal.settled();
    expect(db.query("SELECT epoch,closed FROM dialogue_conversations").get(),"EXPIRED_OPEN_HAS_NO_LATE_STORAGE_EFFECT").toEqual({epoch:1,closed:1});
    await journal.open({...opening,epoch:3});
    expect(db.query("SELECT epoch,closed FROM dialogue_conversations").get()).toEqual({epoch:3,closed:0});
  }finally{release();clock?.restore();await journal.settled();db.close();}
});

test("late cleanup of an expired submitted opening preserves its genuine storage error",async()=>{
  const db=createUiDb(":memory:"),catalog=createSessionCatalog(()=>db),journal=new DialogueJournal(catalog,()=>{},()=>{});
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  const open=catalog.dialogueOpen!, failure=Error("The Ithaca close marker was refused.");
  catalog.dialogueOpen=async input=>{const owner=await open(input);await held;return owner;};
  catalog.dialogueClose=async()=>{throw failure;};
  const clock=storageDeadlineClock();
  try{
    const pending=journal.open(opening).catch(e=>e);
    await checkpoint();clock.expire();
    const outcome=await pending;expect(outcome).toBeInstanceOf(StorageSettlementIndeterminate);
    release();
    let cleanupError:unknown;try{await outcome.cleanup;}catch(e){cleanupError=e;}
    expect(cleanupError,"LATE_OPEN_CLEANUP_PRESERVES_REAL_ERROR").toBe(failure);
    let report:unknown;try{await journal.settled(true);}catch(e){report=e;}
    expect(report).toBe(failure);
  }finally{release();clock.restore();await journal.settled();db.close();}
});
