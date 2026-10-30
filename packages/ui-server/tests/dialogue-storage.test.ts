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
