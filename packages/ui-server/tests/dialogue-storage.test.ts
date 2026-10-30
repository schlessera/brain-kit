import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import * as writes from "../src/ws/session-catalog-writes.js";
import { dialogueOwner, readDialogue } from "../src/ws/dialogue-storage.js";
import type {
  DialogueAppend,
  DialogueOpen,
} from "../src/ws/dialogue-storage.js";
import type { DialogueRecord } from "@schlessera/brain-ui-sdk/protocol";

const opening: DialogueOpen = {
  conversationId: "ithaca",
  principalId: "odysseus",
  epoch: 1,
  providerId: "gemini-live",
};
const fragment = (i: number, text = "raft "): DialogueAppend => ({
  ownerId: "ithaca",
  principalId: "odysseus",
  generation: 1,
  identity: `recognition:${i}`,
  evidence: {
    kind: "voice",
    conversationId: "ithaca",
    epoch: 1,
    providerId: "gemini-live",
    event: {
      kind: "unassigned_input_fragment",
      sequence: i,
      text,
      timing: { kind: "unavailable" },
      finalization: i === 3 ? "final" : "unknown",
    },
  },
});
async function refused(promise: Promise<unknown>, text: string) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(text);
}

test("native FULL writer retains exact deltas and empty finish across close/reopen, with no replay queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-dialogue-"));
  const path = join(dir, "ui.db");
  let db = createUiDb(path);
  let writer = openSqliteWriter(db);
  try {
    expect(writer.offloop).toBe(true);
    const channel = writer.channel(
      { url: writes.url, setup: writes.setup },
      {}
    );
    await channel.call("dialogueOpen", opening);
    const inputs = [
      fragment(0, "Find"),
      fragment(1, " the raft."),
      fragment(2, "Find"),
      fragment(3, ""),
    ];
    const rows = await Promise.all(
      inputs.map((input) =>
        channel.call<DialogueRecord>("dialogueAppend", input)
      )
    );
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3, 4]);
    const duplicate = await channel.call<DialogueRecord>(
      "dialogueAppend",
      inputs[0]
    );
    expect(duplicate.sequence).toBe(1);
    await refused(
      channel.call("dialogueAppend", fragment(0, "different")),
      "Conflicting"
    );
    await refused(
      channel.call("dialogueAppend", { ...inputs[0], principalId: "circe" }),
      "ownership"
    );
    await channel.call("dialogueBind", "ithaca", "odysseus", "voyage");
    await channel.close();
    await writer.close();
    db.close();
    db = createUiDb(path);
    writer = openSqliteWriter(db);
    const page = readDialogue(db, "odysseus", { sessionId: "voyage" })!;
    expect(page.records).toHaveLength(4);
    expect(
      page.records.flatMap((r) =>
        r.evidence.kind === "voice" ? [r.evidence.event.text] : []
      )
    ).toEqual(["Find", " the raft.", "Find", ""]);
    expect(
      (
        db.query("SELECT COUNT(*) n FROM conversation_tasks").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  } finally {
    await writer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive paging survives transient limits, freezes high-water and fences generations", async () => {
  const db = createUiDb(":memory:");
  const writer = openSqliteWriter(db);
  const c = writer.channel({ url: writes.url, setup: writes.setup }, {});
  try {
    await c.call("dialogueOpen", opening);
    const count = 20_051;
    for (let i = 0; i < count; i++)
      await c.call("dialogueAppend", fragment(i, "mast ".repeat(20)));
    const newest = readDialogue(db, "odysseus", { ownerId: "ithaca" })!;
    expect(newest.records).toHaveLength(200);
    expect(newest.through).toBe(count);
    await c.call("dialogueAppend", fragment(count, "tail"));
    let page = newest;
    const seen = [...page.records];
    while (page.before) {
      page = readDialogue(db, "odysseus", {
        ownerId: page.ownerId,
        cursor: page.cursor,
        generation: page.generation,
      })!;
      seen.unshift(...page.records);
    }
    expect(seen.map((r) => r.sequence)).toEqual(
      Array.from({ length: count }, (_, i) => i + 1)
    );
    expect(() => readDialogue(db, "circe", { ownerId: "ithaca" })).toThrow(
      "ownership"
    );
    expect(() =>
      readDialogue(db, "odysseus", { ownerId: "ithaca", generation: 2 })
    ).toThrow("generation");
    await refused(
      c.call("dialogueAppend", { ...fragment(700), generation: 2 }),
      "generation"
    );
    await c.call("conversationEpoch", {
      id: "ithaca",
      principalId: "odysseus",
      epoch: 1,
    });
    for (let i = 0; i < 65; i++)
      await c.call("conversationEpoch", {
        id: `native-${i}`,
        principalId: "odysseus",
        epoch: 1,
      });
    expect(readDialogue(db, "odysseus", { ownerId: "ithaca" })!.through).toBe(
      count + 1
    );
  } finally {
    await c.close();
    await writer.close();
    db.close();
  }
});

test("atomic adoption preserves global order and source engine; wrong epochs and engine reuse refuse", async () => {
  const db = createUiDb(":memory:");
  const w = openSqliteWriter(db);
  const c = w.channel({ url: writes.url, setup: writes.setup }, {});
  try {
    await c.call("dialogueOpen", opening);
    await c.call("dialogueAppend", fragment(0, "old"));
    await c.call("dialogueOpen", {
      ...opening,
      conversationId: "troy",
      sessionId: "voyage",
      providerId: "gpt-live",
    });
    await c.call("dialogueBind", "ithaca", "odysseus", "voyage");
    expect(readDialogue(db, "odysseus", { ownerId: "ithaca" })?.ownerId).toBe(
      "troy"
    );
    await c.call("dialogueAppend", fragment(1, "adopted"));
    const page = readDialogue(db, "odysseus", { sessionId: "voyage" })!;
    expect(page.records.map((r) => r.sequence)).toEqual([1, 2]);
    expect(page.records[0]!.evidence).toMatchObject({
      providerId: "gemini-live",
    });
    await refused(
      c.call("dialogueOpen", { ...opening, providerId: "gpt-live", epoch: 2 }),
      "engine"
    );
    await c.call("dialogueOpen", { ...opening, sessionId: "voyage", epoch: 2 });
    await refused(c.call("dialogueAppend", fragment(2)), "scope");
    await refused(
      c.call("dialogueBind", "ithaca", "odysseus", "another"),
      "cannot change"
    );
  } finally {
    await c.close();
    await w.close();
    db.close();
  }
});

test("real SQLite quota failure rolls back the failed text and position, preserving the committed prefix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-dialogue-quota-"));
  const db = createUiDb(join(dir, "ui.db"));
  const writer = openSqliteWriter(db);
  const c = writer.channel({ url: writes.url, setup: writes.setup }, {});
  const controls = await import("./helpers/dialogue-test-writes.js");
  const q = writer.channel({ url: controls.url, setup: controls.setup }, {});
  try {
    await c.call("dialogueOpen", opening);
    await c.call("dialogueAppend", fragment(0, "committed"));
    await q.call("quota");
    let failed = false,
      accepted = 1;
    for (let i = 1; i < 200; i++) {
      try {
        await c.call("dialogueAppend", fragment(i, "mast ".repeat(400)));
        accepted++;
      } catch (e) {
        expect((e as Error).message).toContain("full");
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    const rows = db
      .query("SELECT sequence,payload FROM dialogue_records ORDER BY sequence")
      .all() as { sequence: number; payload: string }[];
    expect(rows).toHaveLength(accepted);
    expect(rows.map((r) => r.sequence)).toEqual(
      Array.from({ length: accepted }, (_, i) => i + 1)
    );
    expect(rows[0]!.payload).toContain("committed");
  } finally {
    await c.close();
    await q.close();
    await writer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slow FULL writer keeps the app loop responsive and preserves submission order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-dialogue-slow-"));
  const db = createUiDb(join(dir, "ui.db"));
  const writer = openSqliteWriter(db);
  const c = writer.channel({ url: writes.url, setup: writes.setup }, {});
  const controls = await import("./helpers/dialogue-test-writes.js");
  const q = writer.channel({ url: controls.url, setup: controls.setup }, {});
  const control = new Int32Array(new SharedArrayBuffer(8));
  let hold: Promise<unknown> | undefined;
  try {
    await c.call("dialogueOpen", opening);
    hold = q.call("hold", control);
    const deadline = Date.now() + 2000;
    while (!Atomics.load(control, 1)) {
      if (Date.now() > deadline) throw Error("worker did not enter hold");
      await Bun.sleep(1);
    }
    const a = c.call<DialogueRecord>("dialogueAppend", fragment(0, "first")),
      b = c.call<DialogueRecord>("dialogueAppend", fragment(1, "second"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("ready");
      },
    });
    try {
      expect(
        await (await fetch(`http://127.0.0.1:${server.port}`)).text()
      ).toBe("ready");
      expect(
        (
          db.query("SELECT COUNT(*) n FROM dialogue_records").get() as {
            n: number;
          }
        ).n
      ).toBe(0);
    } finally {
      server.stop(true);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
    }
    expect((await Promise.all([a, b])).map((r) => r.sequence)).toEqual([1, 2]);
    await hold;
  } finally {
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    await hold;
    await c.close();
    await q.close();
    await writer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a distinct native process reads committed dialogue without any provider or backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-dialogue-process-"));
  try {
    const fixture = join(import.meta.dir, "fixtures/dialogue-process.ts"),
      path = join(dir, "ui.db");
    const run = async (mode: string) => {
      const child = Bun.spawn([process.execPath, fixture, mode, path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(error).toBe("");
      expect(code).toBe(0);
      return out;
    };
    expect(await run("write")).toContain("written");
    const recovered = JSON.parse(await run("read"));
    expect(recovered.records).toHaveLength(1);
    expect(recovered.records[0].evidence).toMatchObject({
      providerId: "gpt-live",
      event: { text: "The mast is ready." },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("byte-bounded cursor pages preserve Unicode, fence owner/generation and omit non-text provider data", async () => {
  const db = createUiDb(":memory:"),
    writer = openSqliteWriter(db),
    c = writer.channel({ url: writes.url, setup: writes.setup }, {});
  try {
    await c.call("dialogueOpen", opening);
    const text = "🌊".repeat(1000);
    for (let i = 0; i < 80; i++)
      await c.call("dialogueAppend", fragment(i, text));
    const first = readDialogue(db, "odysseus", { ownerId: "ithaca" })!;
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(128 * 1024);
    expect(first.records.length).toBeLessThan(80);
    expect(first.cursor).toBeTruthy();
    await c.call("dialogueOpen", { ...opening, conversationId: "troy" });
    expect(() =>
      readDialogue(db, "odysseus", { ownerId: "troy", cursor: first.cursor })
    ).toThrow("scope");
    db.exec("UPDATE dialogue_owners SET generation=2 WHERE id='ithaca'");
    expect(() =>
      readDialogue(db, "odysseus", { ownerId: "ithaca", cursor: first.cursor })
    ).toThrow("generation");
    const unsafe = fragment(90, "Keep the mast.");
    await c.call("dialogueAppend", {
      ...unsafe,
      generation: 2,
      evidence: {
        ...unsafe.evidence,
        event: {
          kind: "unassigned_input_fragment",
          sequence: 90,
          text: "Keep the mast.",
          timing: { kind: "unavailable" },
          pcm: "never-retain-audio",
          credential: "never-retain-credential",
        },
      },
    });
    const payload = (
      db
        .query("SELECT payload FROM dialogue_records WHERE identity=?")
        .get(unsafe.identity) as { payload: string }
    ).payload;
    expect(payload).not.toContain("never-retain");
    expect(payload).toContain("Keep the mast.");
  } finally {
    await c.close();
    await writer.close();
    db.close();
  }
});

for (const pendingCount of [200, 300])
  test(`the native journal preserves a visible unsaved tail and partial Leave with ${pendingCount} pending observations`, async () => {
    const { DialogueJournal } = await import("../src/ws/dialogue.js");
    const dir = mkdtempSync(join(tmpdir(), "odysseus-dialogue-tail-"));
    const db = createUiDb(join(dir, "ui.db")),
      writer = openSqliteWriter(db);
    const c = writer.channel({ url: writes.url, setup: writes.setup }, {});
    const controls = await import("./helpers/dialogue-test-writes.js");
    const q = writer.channel({ url: controls.url, setup: controls.setup }, {});
    let visible: number[] = [],
      failures = 0,
      published = 0;
    const causes:string[]=[];
    const journal = new DialogueJournal(
      {
        dialogueOpen: (input: DialogueOpen) => c.call("dialogueOpen", input),
        dialogueAppend: (input: DialogueAppend) =>
          c.call("dialogueAppend", input),
        dialogueClose: (
          conversationId: string,
          principalId: string,
          epoch: number,
          partial: boolean
        ) =>
          c.call("dialogueClose", conversationId, principalId, epoch, partial),
      } as import("../src/ws/session-catalog.js").SessionCatalog,
      () => published++,
      (_owner,cause) => {failures++;causes.push(cause);}
    );
    try {
      await journal.open(opening);
      await q.call("quota");
      for (let i = 0; i < pendingCount; i++) {
        const evidence = fragment(i, "mast ".repeat(400)).evidence;
        if (evidence.kind !== "voice") throw Error("voice required");
        expect(
          journal.voice("ithaca", evidence, () => {
            visible.push(i);
          })
        ).toBe(true);
      }
      journal.close("ithaca", "odysseus", 1);
      await journal.settled();
      expect(
        (
          db
            .query("SELECT coverage FROM dialogue_owners WHERE id= ?")
            .get("ithaca") as { coverage: string }
        ).coverage
      ).toBe("partial");
      expect(visible).toEqual(
        Array.from({ length: pendingCount }, (_, i) => i)
      );
      expect(failures).toBe(1);
      expect(causes).toEqual([pendingCount > 256 ? "queue_pressure" : "storage_error"]);
      const rows = db
        .query("SELECT sequence FROM dialogue_records ORDER BY sequence")
        .all() as { sequence: number }[];
      expect(rows.length).toBe(published);
      expect(rows.length).toBeLessThan(256);
      expect(rows.map((r) => r.sequence)).toEqual(
        Array.from({ length: rows.length }, (_, i) => i + 1)
      );
      let closeFailure: unknown;
      try {
        await journal.settled(true);
      } catch (error) {
        closeFailure = error;
      }
      expect(closeFailure).toBeInstanceOf(Error);
    } finally {
      await c.close();
      await q.close();
      await writer.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });


test("native pending pressure is distinct from storage failure and keeps its finite committed prefix", async()=>{
 const {DialogueJournal}=await import("../src/ws/dialogue.js");
 const dir=mkdtempSync(join(tmpdir(),"odysseus-dialogue-pressure-"));
 const db=createUiDb(join(dir,"ui.db")), writer=openSqliteWriter(db);
 const c=writer.channel({url:writes.url,setup:writes.setup},{});
 const controls=await import("./helpers/dialogue-test-writes.js");
 const q=writer.channel({url:controls.url,setup:controls.setup},{});
 const control=new Int32Array(new SharedArrayBuffer(8));
 let hold:Promise<unknown>|undefined;const causes:string[]=[],visible:boolean[]=[];
 const journal=new DialogueJournal({dialogueOpen:(input:DialogueOpen)=>c.call("dialogueOpen",input),dialogueAppend:(input:DialogueAppend)=>c.call("dialogueAppend",input)} as import("../src/ws/session-catalog.js").SessionCatalog,()=>{},(_owner,cause)=>causes.push(cause));
 try{
  await journal.open(opening);hold=q.call("hold",control);
  const deadline=Date.now()+2000;while(!Atomics.load(control,1)){if(Date.now()>deadline)throw Error("writer did not hold");await Bun.sleep(1);}
  for(let i=0;i<257;i++){const e=fragment(i).evidence;if(e.kind!=="voice")throw Error("voice required");journal.voice("ithaca",e,saved=>visible.push(saved));}
  expect(causes).toEqual(["queue_pressure"]);
  Atomics.store(control,0,1);Atomics.notify(control,0);await hold;await journal.settled();
  expect(visible).toEqual([...Array(256).fill(true),false]);
  expect(db.query("SELECT COUNT(*) AS n FROM dialogue_records").get()).toEqual({n:256});
  expect(causes).toEqual(["queue_pressure"]);
 }finally{Atomics.store(control,0,1);Atomics.notify(control,0);await hold;await journal.settled();await q.close();await c.close();await writer.close();db.close();rmSync(dir,{recursive:true,force:true});}
});


test("complete operational backup and restore preserve exact durable dialogue without replay state",async()=>{
 const {exportInboxSnapshot,restoreInboxSnapshot}=await import("../src/inbox/snapshot.js");
 const dir=mkdtempSync(join(tmpdir(),"odysseus-dialogue-backup-")),source=join(dir,"source"),target=join(dir,"target");mkdirSync(source);mkdirSync(target);
 const db=createUiDb(join(source,"ui.db")),writer=openSqliteWriter(db),c=writer.channel({url:writes.url,setup:writes.setup},{});
 try{
  await c.call("dialogueOpen",opening);await c.call("dialogueAppend",fragment(0,"The mast is ready."));await c.call("dialogueClose","ithaca","odysseus",1,false);
  const original=readDialogue(db,"odysseus",{ownerId:"ithaca"})!;
  const snapshot=await exportInboxSnapshot(db,source);
  await restoreInboxSnapshot(snapshot,join(target,"ui.db"),target);
  const restored=createUiDb(join(target,"ui.db"));try{
   expect(readDialogue(restored,"odysseus",{ownerId:"ithaca"}),"OPERATIONAL_BACKUP_PRESERVES_DIALOGUE").toEqual({...original,generation:original.generation+1,coverage:"partial"});
   expect(()=>readDialogue(restored,"odysseus",{ownerId:"ithaca",generation:original.generation})).toThrow("generation");
   expect(()=>readDialogue(restored,"penelope",{ownerId:"ithaca"})).toThrow("ownership");
   expect(restored.query("SELECT COUNT(*) AS n FROM conversation_tasks").get()).toEqual({n:0});
  }finally{restored.close();}
 }finally{await c.close();await writer.close();db.close();rmSync(dir,{recursive:true,force:true});}
});


test("restart read before live open derives partial coverage from an unclosed voice source",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"odysseus-dialogue-unclosed-")),path=join(dir,"ui.db");
 let db=createUiDb(path);const writer=openSqliteWriter(db),c=writer.channel({url:writes.url,setup:writes.setup},{});
 try{await c.call("dialogueOpen",opening);await c.call("dialogueAppend",fragment(0,"Mast note."));await c.close();await writer.close();db.close();db=createUiDb(path);
  expect(db.query("SELECT coverage FROM dialogue_owners").get()).toEqual({coverage:"complete"});
  expect(readDialogue(db,"odysseus",{ownerId:"ithaca"})!.coverage,"UNCLOSED_READ_IS_NOT_COMPLETE").toBe("partial");
 }finally{await c.close();await writer.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("backend append failure after Leave does not falsely mark retained voice as lost",async()=>{
 const {DialogueJournal}=await import("../src/ws/dialogue.js");
 const dir=mkdtempSync(join(tmpdir(),"odysseus-dialogue-after-leave-")),path=join(dir,"ui.db");
 let db=createUiDb(path);const writer=openSqliteWriter(db),c=writer.channel({url:writes.url,setup:writes.setup},{});
 const controls=await import("./helpers/dialogue-test-writes.js"),q=writer.channel({url:controls.url,setup:controls.setup},{});let failures=0;
 const journal=new DialogueJournal({dialogueOwnerForSession:(sessionId:string)=>dialogueOwner(db,{sessionId},"odysseus"),dialogueAppend:(input:DialogueAppend)=>c.call("dialogueAppend",input)} as import("../src/ws/session-catalog.js").SessionCatalog,()=>{},()=>failures++);
 try{
  await c.call("dialogueOpen",opening);await c.call("dialogueAppend",fragment(0,"Saved spoken prefix."));await c.call("dialogueBind","ithaca","odysseus","voyage");await c.call("dialogueClose","ithaca","odysseus",1,false);
  await q.call("quota");journal.backend({type:"text_delta",sessionId:"voyage",turnId:"mast-turn",text:"mast ".repeat(8000)});await journal.settled();
  let failed=false;try{await journal.settled(true);}catch(error){failed=error instanceof Error && /full/i.test(error.message);}expect(failed,"ACTUAL_BACKEND_SQLITE_QUOTA").toBe(true);
  expect(failures,"ONE_FAILURE_NOTICE_PER_OWNER").toBe(1);
  await q.close();await c.close();await writer.close();db.close();db=createUiDb(path);
  // No clean-close or loss-marker write follows the failed background append.
  expect(db.query("SELECT coverage FROM dialogue_owners").get()).toEqual({coverage:"complete"});
  const page=readDialogue(db,"odysseus",{sessionId:"voyage"})!;
  expect(page.coverage,"BACKEND_POSITION_IS_RECONCILED_SEPARATELY_FROM_VOICE_LOSS").toBe("complete");
  expect(page.records[0]!.evidence).toEqual(fragment(0,"Saved spoken prefix.").evidence);
 }finally{await journal.settled();await q.close();await c.close();await writer.close();db.close();rmSync(dir,{recursive:true,force:true});}
});


for(const priorVoice of [false,true])test(`R6 legacy coverage requires real pre-retention voice evidence priorVoice=${priorVoice}`,async()=>{
 const db=createUiDb(":memory:"),writer=openSqliteWriter(db),c=writer.channel({url:writes.url,setup:writes.setup},{});
 try{
 if(priorVoice)await c.call("conversationEpoch",{id:"old-voice",principalId:"odysseus",epoch:1,sessionId:"voyage"});
 const owner=await c.call("dialogueOpen",{...opening,sessionId:"voyage"}) as import("../src/ws/dialogue-storage.js").DialogueOwner;
 expect(owner.coverage,"TYPED_SESSION_IS_NOT_PRIOR_VOICE").toBe(priorVoice?"legacy":"complete");
 }finally{await c.close();await writer.close();db.close();}
});

for(const earlySession of [undefined,"voyage"])test(`R6 midturn first voice retains the actual pre-owner backend offset earlySession=${earlySession}`,async()=>{
 const {DialogueJournal}=await import("../src/ws/dialogue.js");
 const db=createUiDb(":memory:"),writer=openSqliteWriter(db),c=writer.channel({url:writes.url,setup:writes.setup},{});
 const journal=new DialogueJournal({dialogueOpen:(input:DialogueOpen)=>c.call("dialogueOpen",input),dialogueOwnerForSession:(sessionId:string)=>dialogueOwner(db,{sessionId},"odysseus"),dialogueAppend:(input:DialogueAppend)=>c.call("dialogueAppend",input)} as import("../src/ws/session-catalog.js").SessionCatalog,()=>{},()=>{});
 try{
 journal.backend({type:"text_delta",...(earlySession?{sessionId:earlySession}:{}),turnId:"typed-turn",text:"Part one. "});
 await journal.open({...opening,sessionId:"voyage"});
 journal.backend({type:"text_delta",sessionId:"voyage",turnId:"typed-turn",text:"Part two."});await journal.settled();
 const page=readDialogue(db,"odysseus",{sessionId:"voyage"})!;
 expect(page.records[0]!.evidence,"MIDTURN_START_OFFSET").toMatchObject({kind:"backend",start:10,end:19,text:"Part two."});
 journal.retireTurn("typed-turn");expect((journal as unknown as {offsets:Map<string,number>}).offsets.size,"RETIREMENT_RELEASES_OFFSET").toBe(0);
 for(let i=0;i<300;i++){journal.backend({type:"text_delta",sessionId:"pylos",turnId:`typed-${i}`,text:"A mast note."});const terminal={type:"result" as const,sessionId:"pylos",turnId:`typed-${i}`,outcome:"success" as const,isError:false,durationMs:1,numTurns:1};journal.backend(terminal);}
 expect((journal as unknown as {offsets:Map<string,number>}).offsets.size,"TYPED_ONLY_RESULTS_RELEASE_OFFSETS").toBe(0);
 }finally{await journal.settled();await c.close();await writer.close();db.close();}
});

for(const legacy of [false,true])test(`R6 healthy active catalog reads stay honest across reopen legacy=${legacy}`,async()=>{
 const {createSessionCatalog}=await import("../src/ws/session-catalog.js");
 const {createOffloopActivityStore}=await import("../src/activity/store-writes.js");
 const dir=mkdtempSync(join(tmpdir(),"odysseus-active-dialogue-")),path=join(dir,"ui.db");
 const db=createUiDb(path),writer=openSqliteWriter(db);
 const make=()=>createSessionCatalog(()=>db,undefined,undefined,{writer,pricing:{resolve:()=>null},store:createOffloopActivityStore(db,writer)});
 const catalog=make();try{
 if(legacy)await catalog.saveConversationEpoch!({id:"old-voice",principalId:"odysseus",epoch:1,sessionId:"voyage"});
 const owner=await catalog.dialogueOpen!({...opening,sessionId:"voyage"});
 expect((await catalog.dialogueRead!("odysseus",{ownerId:"ithaca"}))!.coverage,"HEALTHY_ACTIVE_READ_HAS_NO_FALSE_PARTIAL").toBe(legacy?"legacy":"complete");
 if(!legacy){
 const generation=owner.generation;owner.generation++;
 expect((await catalog.dialogueRead!("odysseus",{ownerId:"ithaca"}))!.coverage,"ACTIVE_GENERATION_MUST_MATCH").toBe("partial");owner.generation=generation;
 const principal=owner.principal_id;owner.principal_id="penelope";
 expect((await catalog.dialogueRead!("odysseus",{ownerId:"ithaca"}))!.coverage,"ACTIVE_PRINCIPAL_MUST_MATCH").toBe("partial");owner.principal_id=principal;
 }
 owner.coverage="partial";
 expect((await catalog.dialogueRead!("odysseus",{ownerId:"ithaca"}))!.coverage,"FAILED_ACTIVE_OWNER_IS_NOT_MASKED").toBe("partial");
 owner.coverage=legacy?"legacy":"complete";
 const reopened=make();expect((await reopened.dialogueRead!("odysseus",{ownerId:"ithaca"}))!.coverage,"REOPEN_BEFORE_START_IS_PARTIAL").toBe(legacy?"legacy":"partial");
 }finally{await catalog.settled?.();await writer.close();db.close();rmSync(dir,{recursive:true,force:true});}
});


test("R6 adoption does not detach failed queued voice from active coverage",async()=>{
 const {createSessionCatalog}=await import("../src/ws/session-catalog.js");const {createOffloopActivityStore}=await import("../src/activity/store-writes.js");const {DialogueJournal}=await import("../src/ws/dialogue.js");
 const dir=mkdtempSync(join(tmpdir(),"odysseus-adoption-coverage-")),path=join(dir,"ui.db"),db=createUiDb(path),writer=openSqliteWriter(db);
 const controls=await import("./helpers/dialogue-test-writes.js"),q=writer.channel({url:controls.url,setup:controls.setup},{});
 const catalog=createSessionCatalog(()=>db,undefined,undefined,{writer,pricing:{resolve:()=>null},store:createOffloopActivityStore(db,writer)}),journal=new DialogueJournal(catalog,()=>{},()=>{});
 try{await journal.open(opening);await q.call("quota");journal.bind("ithaca","odysseus","voyage");
 for(let i=0;i<30;i++){const e=fragment(i,"mast ".repeat(390)).evidence;if(e.kind!=="voice")throw Error("voice required");journal.voice("ithaca",e,()=>{});}
 await journal.settled();let full=false;try{await journal.settled(true);}catch(error){full=error instanceof Error && /full/i.test(error.message);}expect(full,"ACTUAL_ADOPTION_QUOTA_FAILURE").toBe(true);
 expect(db.query("SELECT coverage FROM dialogue_owners").get()).toEqual({coverage:"complete"});
 expect((await catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage,"QUEUED_PRE_ADOPTION_FAILURE_REMAINS_PARTIAL").toBe("partial");
 }finally{await journal.settled();await q.close();await writer.close();db.close();rmSync(dir,{recursive:true,force:true});}
});


async function r7Fixture(){
 const {createSessionCatalog}=await import("../src/ws/session-catalog.js"),{createOffloopActivityStore}=await import("../src/activity/store-writes.js"),{DialogueJournal}=await import("../src/ws/dialogue.js");
 const dir=mkdtempSync(join(tmpdir(),"odysseus-takeover-")),db=createUiDb(join(dir,"ui.db")),writer=openSqliteWriter(db);
 const catalog=createSessionCatalog(()=>db,undefined,undefined,{writer,pricing:{resolve:()=>null},store:createOffloopActivityStore(db,writer)}),journal=new DialogueJournal(catalog,()=>{},()=>{});
 return {db,writer,catalog,journal,close:async()=>{await journal.settled();await writer.close();db.close();rmSync(dir,{recursive:true,force:true});}};
}

test("R7 same-tick takeover closes the old epoch after queued observations and before reopening",async()=>{
 const f=await r7Fixture();try{
 await f.journal.open(opening);const observed:number[]=[];
 for(let i=0;i<30;i++){const e=fragment(i,`Mast ${i}.`).evidence;if(e.kind!=="voice")throw Error("voice required");f.journal.voice("ithaca",e,()=>{observed.push(i);});}
 f.journal.close("ithaca","odysseus",1);await f.journal.open({...opening,epoch:2});await f.journal.settled();
 expect(f.db.query("SELECT coverage FROM dialogue_owners").get(),"TAKEOVER_DB_REMAINS_COMPLETE").toEqual({coverage:"complete"});
 const page=await f.catalog.dialogueRead!("odysseus",{ownerId:"ithaca"});expect(page!.coverage,"TAKEOVER_READ_REMAINS_COMPLETE").toBe("complete");
 expect(observed).toEqual(Array.from({length:30},(_,i)=>i));expect(page!.records.map(r=>r.evidence)).toEqual(Array.from({length:30},(_,i)=>fragment(i,`Mast ${i}.`).evidence));
 expect(f.db.query("SELECT epoch,closed FROM dialogue_conversations").get()).toEqual({epoch:2,closed:0});
 f.journal.close("ithaca","odysseus",1);f.journal.close("ithaca","penelope",2);await f.journal.settled();
 expect(f.db.query("SELECT epoch,closed FROM dialogue_conversations").get(),"STALE_OR_FOREIGN_CLOSE_CANNOT_RETIRE_CURRENT_EPOCH").toEqual({epoch:2,closed:0});
 }finally{await f.close();}
});

test("R7 replacement while an earlier open is pending cannot orphan its close",async()=>{
 const f=await r7Fixture();let release!:()=>void,entered=false;const open=f.catalog.dialogueOpen!;
 f.catalog.dialogueOpen=async input=>{if(input.epoch===2){entered=true;await new Promise<void>(r=>{release=r;});}return open(input);};
 try{await f.journal.open(opening);f.journal.close("ithaca","odysseus",1);const second=f.journal.open({...opening,epoch:2});f.journal.close("ithaca","odysseus",2);const third=f.journal.open({...opening,epoch:3});
 while(!entered)await Bun.sleep(1);release();await Promise.all([second,third]);await f.journal.settled();
 expect(f.db.query("SELECT epoch,closed FROM dialogue_conversations").get()).toEqual({epoch:3,closed:0});expect((await f.catalog.dialogueRead!("odysseus",{ownerId:"ithaca"}))!.coverage,"PENDING_OPEN_TAKEOVER_IS_NOT_INTERRUPTION").toBe("complete");
 }finally{release?.();await f.close();}
});

test("R7 an unrelated owner's delayed observation cannot serialize another conversation reopen",async()=>{
 const f=await r7Fixture();let release!:()=>void;const append=f.catalog.dialogueAppend!;
 f.catalog.dialogueAppend=async input=>{if(input.ownerId==="pylos")await new Promise<void>(r=>{release=r;});return append(input);};
 try{await f.journal.open(opening);await f.journal.open({...opening,conversationId:"pylos"});const e=fragment(0).evidence;if(e.kind!=="voice")throw Error("voice required");f.journal.voice("pylos",{...e,conversationId:"pylos"},()=>{});
 f.journal.close("ithaca","odysseus",1);const reopened=f.journal.open({...opening,epoch:2});
 const outcome=await Promise.race([reopened.then(()=>"open"),Bun.sleep(200).then(()=>"blocked")]);expect(outcome,"UNRELATED_OWNER_DOES_NOT_BLOCK_REOPEN").toBe("open");
 expect(f.db.query("SELECT epoch FROM dialogue_conversations WHERE id='ithaca'").get()).toEqual({epoch:2});
 }finally{release?.();await f.close();}
});


test("R7 a failed exact close blocks its waiting open and preserves partial recovery",async()=>{
 const f=await r7Fixture();const controls=await import("./helpers/dialogue-test-writes.js"),q=f.writer.channel({url:controls.url,setup:controls.setup},{});
 try{await f.journal.open(opening);await q.call("refuseClose");f.journal.close("ithaca","odysseus",1);
 await refused(f.journal.open({...opening,epoch:2}),"R7 close refused");await f.journal.settled();
 expect(f.db.query("SELECT epoch,closed FROM dialogue_conversations").get(),"FAILED_CLOSE_CANNOT_BE_OVERTAKEN").toEqual({epoch:1,closed:0});
 expect((await f.catalog.dialogueRead!("odysseus",{ownerId:"ithaca"}))!.coverage).toBe("partial");await refused(f.journal.settled(true),"R7 close refused");
 await q.call("allowClose");await f.journal.open({...opening,epoch:3});expect((await f.catalog.dialogueRead!("odysseus",{ownerId:"ithaca"}))!.coverage,"REAL_INTERRUPTION_IS_NOT_SUPPRESSED").toBe("partial");
 }finally{await q.close();await f.close();}
});


test("R7 a second healthy live native identity does not fabricate interruption for the same chat",async()=>{
 const f=await r7Fixture();try{
 await f.journal.open({...opening,sessionId:"voyage"});await f.journal.open({...opening,conversationId:"pylos",sessionId:"voyage"});
 expect(f.db.query("SELECT coverage FROM dialogue_owners").get(),"OTHER_LIVE_ID_IS_NOT_INTERRUPTION").toEqual({coverage:"complete"});expect((await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage).toBe("complete");
 expect(f.db.query("SELECT COUNT(*) AS n FROM dialogue_conversations WHERE closed=0").get()).toEqual({n:2});
 }finally{await f.close();}
});


test("R8 simultaneous healthy conversations for one known chat remain complete",async()=>{
 const f=await r7Fixture();try{
 await Promise.all([f.journal.open({...opening,sessionId:"voyage"}),f.journal.open({...opening,conversationId:"pylos",sessionId:"voyage"})]);
 expect(f.db.query("SELECT coverage FROM dialogue_owners").get(),"CONCURRENT_CHAT_OPENS_DB_COMPLETE").toEqual({coverage:"complete"});
 expect((await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage,"CONCURRENT_CHAT_OPENS_READ_COMPLETE").toBe("complete");
 for(const [i,id] of ["ithaca","pylos"].entries()){const e=fragment(i).evidence;if(e.kind!=="voice")throw Error("voice required");f.journal.voice(id,{...e,conversationId:id},()=>{});}
 await f.journal.settled();const page=await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"});expect(page!.records.map(r=>r.evidence.kind==="voice"?r.evidence.conversationId:null)).toEqual(["ithaca","pylos"]);
 expect(f.db.query("SELECT COUNT(*) AS n FROM dialogue_conversations WHERE closed=0").get()).toEqual({n:2});
 }finally{await f.close();}
});

test("R8 direct catalog same-ID reopen without close remains partial despite active identity",async()=>{
 const f=await r7Fixture();try{
 await f.catalog.dialogueOpen!({...opening,sessionId:"voyage"});await f.catalog.dialogueOpen!({...opening,sessionId:"voyage",epoch:2});
 expect(f.db.query("SELECT coverage FROM dialogue_owners").get(),"SAME_ID_WITHOUT_CLOSE_DB_PARTIAL").toEqual({coverage:"partial"});
 expect((await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage,"SAME_ID_WITHOUT_CLOSE_READ_PARTIAL").toBe("partial");
 }finally{await f.close();}
});


test("R8 adopted sibling live scopes retain their canonical owner identity",async()=>{
 const f=await r7Fixture();try{
 await f.catalog.dialogueOpen!({...opening,conversationId:"sparta",sessionId:"voyage"});await f.catalog.dialogueClose!("sparta","odysseus",1,false);
 const first=await f.catalog.dialogueOpen!(opening),sibling=await f.catalog.dialogueOpen!({...opening,conversationId:"pylos",historyOwnerId:"ithaca"});
 await f.catalog.dialogueBind!("pylos","odysseus","voyage");expect([first.id,sibling.id],"ADOPTED_LIVE_REFERENCES_STAY_CANONICAL").toEqual(["sparta","sparta"]);await f.catalog.dialogueOpen!({...opening,conversationId:"troy",sessionId:"voyage"});
 expect(f.db.query("SELECT coverage FROM dialogue_owners").get(),"ADOPTED_SIBLING_SCOPES_DB_COMPLETE").toEqual({coverage:"complete"});
 expect((await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage,"ADOPTED_SIBLING_SCOPES_READ_COMPLETE").toBe("complete");
 }finally{await f.close();}
});


test("R8 failed concurrent open rolls back its reservation without poisoning another chat conversation",async()=>{
 const f=await r7Fixture(),controls=await import("./helpers/dialogue-test-writes.js"),q=f.writer.channel({url:controls.url,setup:controls.setup},{});try{
 await q.call("refuseOpen");const results=await Promise.allSettled([f.catalog.dialogueOpen!({...opening,sessionId:"voyage"}),f.catalog.dialogueOpen!({...opening,conversationId:"pylos",sessionId:"voyage"})]);
 expect(results[0].status).toBe("rejected");expect(results[1].status).toBe("fulfilled");expect(f.db.query("SELECT id FROM dialogue_conversations").all()).toEqual([{id:"pylos"}]);
 await q.call("allowOpen");await f.catalog.dialogueOpen!({...opening,sessionId:"voyage"});expect((await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage,"FAILED_OPEN_RESERVATION_RETIRED").toBe("complete");
 }finally{await q.close();await f.close();}
});

test("R8 close during a worker-pending open cannot resurrect a retired runtime scope",async()=>{
 const f=await r7Fixture(),controls=await import("./helpers/dialogue-test-writes.js"),q=f.writer.channel({url:controls.url,setup:controls.setup},{}),gate=new Int32Array(new SharedArrayBuffer(8));let hold:Promise<unknown>|undefined;
 try{hold=q.call("hold",gate);while(!Atomics.load(gate,1))await Bun.sleep(1);
 const first=f.catalog.dialogueOpen!({...opening,sessionId:"voyage"}),closed=f.catalog.dialogueClose!("ithaca","odysseus",1,false),second=f.catalog.dialogueOpen!({...opening,conversationId:"pylos",sessionId:"voyage"});
 Atomics.store(gate,0,1);Atomics.notify(gate,0);await Promise.all([hold,first,closed,second]);
 expect(f.db.query("SELECT id,closed FROM dialogue_conversations ORDER BY id").all()).toEqual([{id:"ithaca",closed:1},{id:"pylos",closed:0}]);expect((await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage).toBe("complete");
 // An out-of-band unclosed row is not trusted merely because the earlier
 // acknowledgement arrived after close had already retired its scope.
 await q.call("loseCloseMarker","ithaca");
 expect((await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage,"CLOSED_PENDING_SCOPE_CANNOT_MASK_UNCLOSED_RESTART").toBe("partial");
 }finally{Atomics.store(gate,0,1);Atomics.notify(gate,0);await hold;await q.close();await f.close();}
});

for(const fence of ["healthy","generation","principal","epoch","provider","previous","owner","session","history"] as const)test(`R8 pending open liveness validates committed identity: ${fence}`,async()=>{
 const f=await r7Fixture(),q=f.writer.channel({url:writes.url,setup:writes.setup},{});try{
 await q.call("dialogueOpen",{...opening,sessionId:"voyage"});
 const pending={input:{...opening,sessionId:fence==="session"?"sparta":"voyage",...(fence==="history"?{historyOwnerId:"missing"}:{}),...(fence==="principal"?{principalId:"penelope"}:{}),...(fence==="epoch"?{epoch:2}:{}),...(fence==="provider"?{providerId:"gpt-live"}:{})},generation:fence==="generation"?2:1,...(fence==="previous"?{previousEpoch:1}:{}),...(fence==="owner"?{ownerId:"missing"}:fence==="session"||fence==="history"?{ownerId:"ithaca"}:{})};
 const owner=await q.call<{coverage:string}>("dialogueOpen",{...opening,conversationId:"pylos",sessionId:"voyage"},new Map(),[pending]);
 expect(owner.coverage,`PENDING_IDENTITY_FENCE_${fence}`).toBe(fence==="healthy"?"complete":"partial");
 }finally{await q.close();await f.close();}
});


test("R8 writer-pending adoption preserves exact healthy sibling identities on the next open",async()=>{
 const f=await r7Fixture();try{
 await f.catalog.dialogueOpen!({...opening,conversationId:"sparta",sessionId:"voyage"});await f.catalog.dialogueClose!("sparta","odysseus",1,false);
 await f.catalog.dialogueOpen!(opening);await f.catalog.dialogueOpen!({...opening,conversationId:"pylos",historyOwnerId:"ithaca"});
 const adoption=f.catalog.dialogueBind!("pylos","odysseus","voyage"),next=f.catalog.dialogueOpen!({...opening,conversationId:"troy",sessionId:"voyage"});await Promise.all([adoption,next]);
 expect(f.db.query("SELECT coverage FROM dialogue_owners").get(),"PENDING_ADOPTION_DB_COMPLETE").toEqual({coverage:"complete"});expect((await f.catalog.dialogueRead!("odysseus",{sessionId:"voyage"}))!.coverage).toBe("complete");
 }finally{await f.close();}
});
