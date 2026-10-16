import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createClaudeWorkerState } from "../../ui-backend-claude/src/worker-state.js";
import { createStateLedger } from "../../ui-backend-claude/src/worker-state-budget.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createTurnReverts } from "../src/brain/turn-revert.js";
import { createWriterGate } from "../src/brain/writer-gate.js";
import { recordGovernanceEvent, queryGovernanceEvents } from "../src/governance/events.js";

function fixture(capBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-memory-history-")), brain = join(root, "brain"), saved = join(root, "config"), path = join(root, "ui.db");
  mkdirSync(brain); mkdirSync(saved);
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`, memory = join(saved, project, "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "voyage.md"), Buffer.from([65, 13, 10, 255]), { mode: 0o600 });
  const native = createNativeJournalFixture(brain, root), db = createUiDb(path);
  let journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), capBytes });
  db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Homeward',1,1)").run();
  const states: ReturnType<typeof createClaudeWorkerState>[] = [];
  function worker(id: string) {
    const state = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved }, { ledger: createStateLedger() }); states.push(state);
    const temporary = join(root, id); mkdirSync(temporary); state.populate(temporary);
    return { state, temporary, notes: join(temporary, project, "memory"), persist() { state.persist(temporary, undefined, (change, save) => journal.persistClaudeMemory(id, change, save)); } };
  }
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: "odysseus-model", profile: "governed", policyHash: "recorded-policy" }, () => {});
  const reverts = () => createTurnReverts(db, { brainPath: brain, journal, gate: createWriterGate(db, brain, { pollMs: 1 }), lock: createKeyedLock(), isAuthorized: id => id === "odysseus", refresh() {} });
  return { root, brain, saved, memory, db, get journal() { return journal; }, worker, begin, reverts,
    async reopen() { await journal.close(); journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), capBytes }); },
    async close() { for (const state of states) state.release(); await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("real populate/persist retains created and replaced external notes with taint, replay and user revert/Undo", async () => {
  const f = fixture(); try {
    await f.begin("return");
    recordGovernanceEvent(f.db, { kind: "taint", sessionId: "ithaca", turnId: "return", actor: "interactive", model: "odysseus-model", profile: "governed", payload: { source: "user_marked", tool: "fixture", detail: "Recorded untrusted voyage report" } });
    const w = f.worker("return"), after = Buffer.from([66, 10, 0, 255]);
    writeFileSync(join(w.notes, "voyage.md"), after); writeFileSync(join(w.notes, "athena.md"), "Counsel\r\n");
    writeFileSync(join(f.brain, "content.md"), "Unrelated content\n");
    w.persist(); await f.journal.finish("return");
    await f.reopen();
    const details = f.journal.details("ithaca", "return")!;
    const notes = details.changes.filter(c => c.scope === "claude_memory");
    expect(notes.length, "MEMORY_REAL_PERSIST_REACHES_RETAINED_JOURNAL").toBe(2);
    expect(details.summary).toMatchObject({ state: "complete", changedFiles: 3, steeringFiles: 2, model: "odysseus-model", profile: "governed" });
    expect(notes.every(c => c.class === "steering" && c.tainted && c.taintSourceEventId)).toBe(true);
    expect(notes.find(c => c.path.endsWith("athena.md"))?.before).toBeNull();
    const replaced = notes.find(c => c.path.endsWith("voyage.md"))!;
    expect(f.journal.version("ithaca", "return", replaced.sequence, "before")!.bytes(32)).toEqual(Buffer.from([65, 13, 10, 255]));
    expect(f.journal.version("ithaca", "return", replaced.sequence, "after")!.bytes(32)).toEqual(after);
    expect(queryGovernanceEvents(f.db, { sessionId: "ithaca", turnId: "return", kinds: ["steering_change"], limit: 100 }).length).toBe(2);
    expect(JSON.stringify(details)).not.toContain(f.saved);
    expect(f.journal.details("other", "return")).toBeNull();
    const r = f.reverts();
    expect(() => r.start("odysseus", "ithaca", "return", { id: "memory_forged_0001", path: join(f.memory, "voyage.md") })).toThrow("No retained eligible paths");
    expect(() => r.start("agent", "ithaca", "return", { id: "memory_agent_0001" })).toThrow();
    const receipt = r.start("odysseus", "ithaca", "return", { id: "memory_revert_0001", path: replaced.path }); await r.idle(receipt.id);
    expect(r.receipt(receipt.id, "odysseus", "ithaca", "return")?.state, "MEMORY_REVERT_SUCCEEDS_FROM_PRIVATE_RETAINED_MAPPING").toBe("complete");
    expect(readFileSync(join(f.memory, "voyage.md"))).toEqual(Buffer.from([65, 13, 10, 255]));
    expect(readFileSync(join(f.brain, "content.md"), "utf8")).toBe("Unrelated content\n");
    const undo = r.start("odysseus", "ithaca", receipt.journalTurnId, { id: "memory_undo_00001" }); await r.idle(undo.id);
    expect(readFileSync(join(f.memory, "voyage.md"))).toEqual(after);
    const created = r.start("odysseus", "ithaca", "return", { id: "memory_create_revert", path: "claude-memory://athena.md" }); await r.idle(created.id);
    expect(existsSync(join(f.memory, "athena.md"))).toBe(false);
    await r.close();
  } finally { await f.close(); }
});

test("peer persistence refuses only the stale note, retains successful notes and a stale reviewed revert preserves peer bytes", async () => {
  const f = fixture(); try {
    await f.begin("return"); const stale = f.worker("return");
    await f.begin("athena"); const peer = f.worker("athena");
    writeFileSync(join(peer.notes, "voyage.md"), "Peer counsel\n"); peer.persist(); await f.journal.finish("athena");
    writeFileSync(join(stale.notes, "voyage.md"), "Stale counsel\n"); writeFileSync(join(stale.notes, "telemachus.md"), "Independent\n");
    expect(() => stale.persist()).toThrow("changed concurrently"); await f.journal.finish("return");
    expect(readFileSync(join(f.memory, "voyage.md"), "utf8"), "MEMORY_PEER_PERSIST_IS_NEVER_OVERWRITTEN").toBe("Peer counsel\n");
    expect(readFileSync(join(f.memory, "telemachus.md"), "utf8")).toBe("Independent\n");
    expect(f.journal.details("ithaca", "return")?.summary.state).toBe("partial");
    expect(f.journal.details("ithaca", "return")?.changes.some(c => c.path === "claude-memory://voyage.md")).toBe(false);
    const partialReverts = f.reverts();
    expect(partialReverts.plan("ithaca", "return").paths.find(item => item.path === "claude-memory://telemachus.md")?.state, "MEMORY_PARTIAL_SAVE_RETAINS_KNOWN_SUCCESSFUL_RECOVERY").toBe("eligible");
    await partialReverts.close();
    writeFileSync(join(f.memory, "voyage.md"), "Later peer\n");
    const r = f.reverts(), receipt = r.start("odysseus", "ithaca", "athena", { id: "memory_stale_0001", path: "claude-memory://voyage.md" }); await r.idle(receipt.id);
    expect(r.receipt(receipt.id, "odysseus", "ithaca", "athena")?.paths[0]?.state, "MEMORY_STALE_REVERT_PRESERVES_LATER_SAVE").toBe("conflict");
    expect(readFileSync(join(f.memory, "voyage.md"), "utf8")).toBe("Later peer\n"); await r.close();
  } finally { await f.close(); }
});

test("interruption after memory commit retains staged versions and reports unconfirmed persistence after reopen", async () => {
  const f = fixture(); try {
    await f.begin("return"); const w = f.worker("return"); writeFileSync(join(w.notes, "voyage.md"), "Saved before interruption\n");
    expect(() => w.state.persist(w.temporary, undefined, (change, save) => f.journal.persistClaudeMemory("return", change, () => { save(); throw Error("interrupted finalization"); }))).toThrow("interrupted finalization");
    await f.journal.finish("return"); await f.reopen();
    const details = f.journal.details("ithaca", "return")!;
    expect(details.summary.state).toBe("partial");
    expect(details.changes).toEqual([]);
    expect(details.missing, "MEMORY_UNCONFIRMED_SAVE_NEVER_CLAIMS_COMPLETE_HISTORY").toContainEqual({ path: "claude-memory://voyage.md", reason: "memory_persistence_unconfirmed" });
    expect(readFileSync(join(f.memory, "voyage.md"), "utf8")).toBe("Saved before interruption\n");
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_object_refs WHERE turn_id='return'").get(), "MEMORY_UNCONFIRMED_RAW_VERSIONS_REMAIN_PINNED").toEqual({ n: 2 });
  } finally { await f.close(); }
});


test("memory staging overflow refuses before publication and cannot promise a retained successful change", async () => {
  const f = fixture(1024 * 1024); try {
    await f.begin("return"); const w = f.worker("return");
    writeFileSync(join(w.notes, "voyage.md"), Buffer.alloc(2 * 1024 * 1024, 65));
    expect(() => w.persist()).toThrow(); await f.journal.finish("return");
    expect(readFileSync(join(f.memory, "voyage.md")),"MEMORY_CAPACITY_REFUSES_BEFORE_SAVED_BYTES_CHANGE").toEqual(Buffer.from([65,13,10,255]));
    expect(f.journal.details("ithaca","return")?.changes).toEqual([]);
    expect(f.journal.details("ithaca","return")?.summary.state).toBe("partial");
  } finally { await f.close(); }
});

test("changed saved-store identity refuses user memory recovery while keeping its replacement untouched", async () => {
  const { renameSync } = await import("node:fs");
  const f = fixture(); try {
    await f.begin("return"); const w=f.worker("return");writeFileSync(join(w.notes,"voyage.md"),"Saved by turn\n");w.persist();await f.journal.finish("return");
    renameSync(f.memory,`${f.memory}-held`);mkdirSync(f.memory);writeFileSync(join(f.memory,"voyage.md"),"Replacement store\n");
    const r=f.reverts(),receipt=r.start("odysseus","ithaca","return",{id:"memory_store_0001",path:"claude-memory://voyage.md"});await r.idle(receipt.id);
    expect(r.receipt(receipt.id,"odysseus","ithaca","return")?.paths[0]?.state,"MEMORY_STORE_IDENTITY_FENCES_REPLACEMENT").toBe("conflict");
    expect(readFileSync(join(f.memory,"voyage.md"),"utf8")).toBe("Replacement store\n");await r.close();
  } finally { await f.close(); }
});
