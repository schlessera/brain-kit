/** Real SQLite plans and projection parity; no clocks, network or Google transport. */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createPrincipal } from "../src/db/principals.js";
import { cleanChatStore } from "../src/ws/chat-store-cleanup.js";
import { retireChat, resolveChat } from "../src/ws/chat-lifecycle.js";
import { createUiDb } from "../src/db/client.js";
import { acknowledgeSafety, endSafetyCollection, latchSafety, recoverSafetyRecording, safetyProjection } from "../src/governance/safety-store.js";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = createUiDb(":memory:"); databases.push(db);
  db.run("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',1,1),('aeaea',1,1)");
  db.run("UPDATE safety_sessions SET classification='new',principal_id='odysseus',history_owner_id='owner-ithaca',generation='1' WHERE session_id='ithaca'");
  db.run("INSERT INTO dialogue_owners(id,principal_id,generation,coverage,created_at) VALUES('owner-ithaca','odysseus',1,'complete',1),('owner-aeaea','odysseus',1,'complete',1)");
  const collection = (id: string, session = "ithaca", owner = "owner-ithaca", generation = "1") =>
    db.run("INSERT INTO safety_collections(id,turn_id,session_id,history_owner_id,generation,backend_id,started_at,acknowledged,start_revision) VALUES(?,?,?,?,?,'claude',1,?,'1')",
      [id, id, session, owner, generation, JSON.stringify(detectors)]);
  let detectors: string[] = [];
  collection("c0");
  acknowledgeSafety(db, "c0", "claude", 1);
  detectors = JSON.parse((db.query("SELECT acknowledged FROM safety_collections WHERE id='c0'").get() as { acknowledged: string }).acknowledged);
  db.run("UPDATE safety_collections SET principal_id='odysseus'");
  const record = (id = "r0", collectionId = "c0", payload = '{"admission":{"trusted":false}}') =>
    db.run("INSERT INTO safety_records(id,collection_id,sequence,observed_at,kind,occurrence_id,state,payload,bytes,reserved_rows,reserved_bytes) VALUES(?,?,?,1,'occurrence',?,'finalized',?,1,1,1)",
      [id, collectionId, id, id, payload]);
  const allowance = () => db.run("INSERT INTO google_session_allowances VALUES('ithaca','odysseus','brain','odysseus@example.com','gmail.modify','archive','epoch','policy','card',1,86400001,100)");
  const decide = () => db.run("INSERT INTO safety_decisions VALUES('d0','r0','ithaca','owner-ithaca','1','decision','odysseus','request',1,'safe','owner_history')");
  return { db, collection, record, allowance, detectors, decide };
}
type Fixture = ReturnType<typeof fixture>;
// A third entry marks a value the projection cannot read: it throws, so the
// chat is unusable, and the SQL must not count it as normal either.
const cases: Array<[string, (f: Fixture) => void, RegExp?]> = [
  ["normal", () => {}],
  ["discovered", f => f.db.run("UPDATE safety_sessions SET classification='discovered'")],
  ["legacy", f => f.db.run("UPDATE safety_sessions SET classification='legacy'")],
  ["failed", f => f.db.run("UPDATE safety_meta SET failed=1")],
  ["capacity", f => f.db.run("UPDATE safety_meta SET reason='capacity'")],
  ["non-capacity reason", f => f.db.run("UPDATE safety_meta SET reason='recording_failed'")],
  ["gap", f => f.db.run("UPDATE safety_collections SET gap='missing_history'")],
  ["empty gap", f => f.db.run("UPDATE safety_collections SET gap=''")],
  ["failure", f => f.db.run("UPDATE safety_collections SET failure='recording_failed'")],
  ["ended failure", f => f.db.run("UPDATE safety_collections SET failure='recording_failed',ended=1")],
  ["capacity failure", f => f.db.run("UPDATE safety_collections SET failure='capacity'")],
  ["short acknowledgements", f => f.db.run("UPDATE safety_collections SET acknowledged=?", [JSON.stringify(f.detectors.slice(1))])],
  ["complete acknowledgements", f => f.db.run("UPDATE safety_collections SET acknowledged=?", [JSON.stringify(f.detectors)])],
  ["extra acknowledgements", f => f.db.run("UPDATE safety_collections SET acknowledged=?", [JSON.stringify([...f.detectors, "extra"])])],
  ["pending", f => f.db.run("INSERT INTO safety_pending VALUES('p0','c0',1,1,1)")],
  ["untrusted", f => f.record()],
  ["trusted", f => f.record("r0", "c0", '{"admission":{"trusted":true}}')],
  ["nested trusted", f => f.record("r0", "c0", '{"occurrence":{"admission":{"trusted":true}}}')],
  ["decided untrusted", f => { f.record(); f.decide(); }],
  ["decided trusted", f => { f.record("r0", "c0", '{"admission":{"trusted":true}}'); f.decide(); }],
  ["invalid payload", f => f.record("r0", "c0", "not-json"), /malformed JSON/],
  ["decided invalid payload", f => { f.record("r0", "c0", "not-json"); f.decide(); }, /malformed JSON/],
  ["invalid acknowledged", f => f.db.run("UPDATE safety_collections SET acknowledged='not-json'"), /JSON Parse error/],
  ["shared owner", f => { f.collection("shared", "aeaea"); f.record("shared-record", "shared"); }],
  ["foreign owner untrusted", f => { f.collection("foreign", "aeaea", "owner-aeaea"); f.record("foreign-record", "foreign"); }],
  ["foreign pending", f => {
    f.collection("foreign", "aeaea", "owner-aeaea");
    f.db.run("INSERT INTO safety_pending VALUES('foreign-pending','foreign',1,1,1)");
  }],
  ["foreign gap", f => {
    f.collection("foreign", "aeaea", "owner-aeaea");
    f.db.run("UPDATE safety_collections SET gap='missing_history' WHERE id='foreign'");
  }],
  ["foreign generation", f => { f.collection("shared", "aeaea", "owner-ithaca", "2"); f.record("shared-record", "shared"); }],
  ["target alias", f => {
    f.db.run("INSERT INTO dialogue_aliases VALUES('alias-ithaca','owner-ithaca')");
    f.db.run("UPDATE safety_sessions SET history_owner_id='alias-ithaca' WHERE session_id='ithaca'");
    f.collection("shared", "aeaea"); f.record("shared-record", "shared");
  }],
  ["collection alias", f => {
    f.db.run("INSERT INTO dialogue_aliases VALUES('alias-ithaca','owner-ithaca')");
    f.collection("shared", "aeaea", "alias-ithaca"); f.record("shared-record", "shared");
  }],
  ["foreign alias generation", f => {
    f.db.run("INSERT INTO dialogue_aliases VALUES('alias-ithaca','owner-ithaca')");
    f.collection("shared", "aeaea", "alias-ithaca", "2"); f.record("shared-record", "shared");
  }],
  ["no safety session", f => f.db.run("DELETE FROM safety_sessions WHERE session_id='ithaca'")],
  ["zero collections", f => f.db.run("DELETE FROM safety_collections")],
  ["128 collections", f => { for (let i=1;i<128;i++) f.collection("c"+i); }],
  ["129 collections", f => { for (let i=1;i<129;i++) f.collection("c"+i); }],
];
test("Google continuity SQL matches the complete safety projection matrix", () => {
  for (const [name, change, unreadable] of cases) {
    const f = fixture();
    // The migration is immutable after release. Detector-list changes must update its successor.
    expect(f.detectors.length, "GOOGLE_CONTINUITY_DETECTOR_PARITY").toBe(9);
    change(f); f.allowance();
    const normal = !!f.db.query("SELECT 1 FROM google_normal_allowance_sessions WHERE session_id='ithaca'").get();
    if (unreadable) {
      expect(() => safetyProjection(f.db, null, "ithaca"), "GOOGLE_CONTINUITY_UNREADABLE " + name).toThrow(unreadable);
      expect(normal, "GOOGLE_CONTINUITY_PARITY " + name).toBe(false);
    } else expect(normal, "GOOGLE_CONTINUITY_PARITY " + name).toBe(safetyProjection(f.db, null, "ithaca").restriction === "normal");
  }
});

// Producers write only JSON.stringify output, so this is corruption or a
// manual edit. It must stay confined to its chat (#4631).
for (const corrupt of ["payload", "acknowledged"] as const) test(`Google continuity lets brain-wide latch recovery clear past an invalid ${corrupt} in a granted chat`, () => {
  const f = fixture();
  endSafetyCollection(f.db, "c0");
  if (corrupt === "payload") f.record("r0", "c0", "not-json");
  else f.db.run("UPDATE safety_collections SET acknowledged='not-json' WHERE id='c0'");
  f.allowance();
  latchSafety(f.db, null, "recording_failed");
  expect(f.db.query("SELECT failed FROM safety_meta").get()).toEqual({ failed: 1 });
  expect(() => recoverSafetyRecording(f.db), "GOOGLE_CONTINUITY_RECOVERY_" + corrupt).not.toThrow();
  expect(f.db.query("SELECT failed,reason FROM safety_meta").get(), "GOOGLE_CONTINUITY_LATCH_CLEARED_" + corrupt).toEqual({ failed: 0, reason: null });
  // The chat is not counted normal, so it keeps its allowance, which its
  // unreadable projection leaves unusable.
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get(), "GOOGLE_CONTINUITY_UNREADABLE_KEPT_" + corrupt).toEqual({ n: 1 });
  expect(() => safetyProjection(f.db, null, "ithaca")).toThrow();
  // Another chat records again.
  expect(safetyProjection(f.db, null, "aeaea").reasons, "GOOGLE_CONTINUITY_OTHER_CHAT_RECORDS_" + corrupt).not.toContain("recording_failed");
});

test("Google continuity trigger plans never scan history or build automatic indexes", () => {
  const f = fixture(); f.record(); f.allowance();
  const triggers = f.db.query<{name:string;sql:string}, []>("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'google_continuity_%'").all();
  expect(triggers.length).toBeGreaterThan(0);
  for (const trigger of triggers) {
    const substitute = (sql: string) => sql.replace(/(?:OLD|NEW)\.([a-z_]+)/g, (_, field: string) =>
      "'" + (({ session_id: "ithaca", history_owner_id: "owner-ithaca", owner_id: "owner-ithaca", generation: "1", collection_id: "c0", occurrence_id: "r0", id: "c0" } as Record<string, string>)[field] ?? "0") + "'");
    const body = trigger.sql.slice(trigger.sql.indexOf("BEGIN")+5, trigger.sql.lastIndexOf("END"));
    const when = trigger.sql.slice(trigger.sql.indexOf("WHEN")+4, trigger.sql.indexOf("BEGIN"));
    for (const sql of [body, "SELECT " + when]) {
      const plan = f.db.query<{detail:string}, []>("EXPLAIN QUERY PLAN " + substitute(sql)).all();
      // Alias a is allowed only with the allowance table's exact covering index.
      expect(plan.filter(p => /AUTOMATIC/i.test(p.detail)
        || (/\bSCAN\b/i.test(p.detail)
          && p.detail !== "SCAN a USING COVERING INDEX sqlite_autoindex_google_session_allowances_1"
          && !/^SCAN (?:google_session_allowances|t|affected|CONSTANT ROW)(?:$| USING )/.test(p.detail))),
        "GOOGLE_CONTINUITY_INDEXED_PLAN " + trigger.name).toEqual([]);
    }
  }
});

// The cost tests below detect an evaluation by a payload that throws when the
// view reads it. The view guards that read (#4631), so they read it unguarded.
function throwOnPayloadRead(db: Database) {
  const view = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='view' AND name='google_normal_allowance_sessions'").get()!.sql;
  const unguarded = view.replace("CASE WHEN json_valid(r.payload)", "CASE WHEN 1");
  expect(unguarded, "GOOGLE_CONTINUITY_SENTINEL_INSTALLED").not.toBe(view);
  db.run("DROP VIEW google_normal_allowance_sessions"); db.run(unguarded);
  expect(() => db.query("SELECT 1 FROM google_normal_allowance_sessions").all(), "GOOGLE_CONTINUITY_SENTINEL_LIVE").toThrow("malformed JSON");
}

test("Google continuity does not evaluate unrelated history during a large delete", () => {
  const f = fixture();
  // If an unrelated trigger evaluates this allowance's predicate, JSON parsing fails.
  f.record("poison", "c0", "not-json");
  f.collection("unrelated", "aeaea", "owner-aeaea");
  f.db.transaction(() => { for (let i=0;i<2000;i++) f.record("outside"+i, "unrelated"); })();
  f.allowance(); throwOnPayloadRead(f.db);
  const changes = () => (f.db.query("SELECT total_changes() n").get() as {n:number}).n;
  const before = changes();
  expect(() => f.db.transaction(() => {
    for (let i=0;i<2000;i++) f.db.run("DELETE FROM safety_records WHERE id=?", ["outside"+i]);
  })(), "GOOGLE_CONTINUITY_SCOPED_DELETE").not.toThrow();
  expect(changes()-before, "GOOGLE_CONTINUITY_DELETE_CHANGES").toBe(2000);
  // Even when the changed scope has an allowance, another scope's predicate is untouched.
  f.record("last-outside", "unrelated");
  f.db.run("INSERT INTO google_session_allowances VALUES('aeaea','odysseus','brain','odysseus@example.com','gmail.modify','archive','epoch','policy','other-card',1,86400001,100)");
  f.db.run("UPDATE safety_sessions SET classification='new',history_owner_id='owner-aeaea' WHERE session_id='aeaea'");
  expect(() => f.db.run("DELETE FROM safety_records WHERE id='last-outside'"),
    "GOOGLE_CONTINUITY_SCOPED_WITH_ALLOWANCE").not.toThrow();
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get()).toEqual({ n: 1 });
});

test("Google continuity follows canonical owners on pending release and alias changes", () => {
  for (const alias of [false, true]) {
    const f = fixture();
    if (alias) f.db.run("INSERT INTO dialogue_aliases VALUES('alias-ithaca','owner-ithaca')");
    f.collection("shared", "aeaea", alias ? "alias-ithaca" : "owner-ithaca");
    f.db.run("INSERT INTO safety_pending VALUES('pending','shared',1,1,1)");
    f.allowance();
    f.db.run("DELETE FROM safety_pending WHERE id='pending'");
    expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get(), "GOOGLE_SHARED_OWNER_CONTINUITY").toEqual({ n: 0 });
  }
  const f = fixture();
  f.db.run("INSERT INTO dialogue_aliases VALUES('alias-ithaca','owner-ithaca')");
  f.collection("shared", "aeaea", "alias-ithaca"); f.record("r1", "shared"); f.allowance();
  f.db.run("DELETE FROM dialogue_aliases WHERE id='alias-ithaca'");
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get(), "GOOGLE_ALIAS_CONTINUITY").toEqual({ n: 0 });
});

test("Google granted chat scrub never evaluates continuity per deleted occurrence", () => {
  const f = fixture();
  const principal = createPrincipal(f.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  f.db.query("UPDATE principals SET id='odysseus' WHERE id=?").run(principal.id);
  f.db.run("UPDATE dialogue_owners SET session_id='ithaca' WHERE id='owner-ithaca'");
  f.db.transaction(() => {
    for (let i=0;i<1000;i++) f.record(String(i).padStart(6, "0"), "c0", '{"admission":{"trusted":true}}');
    // A sentinel before the final untrusted row throws if cleanup evaluates the view.
    f.record("999998", "c0", "not-json");
    f.record("999999");
  })();
  f.allowance(); throwOnPayloadRead(f.db);
  const chat = resolveChat(f.db, { sessionId: "ithaca" });
  if ("refused" in chat) throw new Error("Fixture chat unavailable");
  const retired = retireChat(f.db, { operationId: "delete-ithaca", principalId: "odysseus", target: { sessionId: "ithaca" },
    expected: { backendId: chat.backendId, generation: chat.generation }, removableBackends: ["claude", "pi"], at: Date.now() });
  if (retired.status !== "retired") throw new Error("Fixture retirement refused");
  cleanChatStore(f.db, retired.lifecycleId, "projections", Date.now());
  expect(f.db.query("SELECT outcome FROM chat_retirement_stores WHERE store='projections'").get(),
    "GOOGLE_GRANTED_SCRUB_NO_EVALUATION").toEqual({ outcome: "removed" });
  expect(f.db.query("SELECT COUNT(*) n FROM safety_records").get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get()).toEqual({ n: 0 });
});
