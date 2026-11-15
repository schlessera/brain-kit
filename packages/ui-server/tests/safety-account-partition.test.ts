/** A chat's safety history binds to the account, not the exact login (#3952). */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { createPrincipal, resolveAmbientPrincipal, resolveSystemPrincipal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { SafetyHistory } from "../src/governance/safety-history";
import { safetyCatalogCreated, safetyRecords } from "../src/governance/safety-store";
import { safetyReviewTarget, type SafetyReviewBody, type SafetyReviewer } from "../src/governance/safety-reviews";
import { sameAccount } from "../src/middleware/account-partition";
import { openDialogue } from "../src/ws/dialogue-storage";
import { rejection } from "./helpers/expect-rejection";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-account-")), path = join(root, "ui.db");
  const db = createUiDb(path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  // Every sign-in mints its own owner principal: one on the ship, one at home.
  const ship = createPrincipal(db, { authMethod: "password", label: "Odysseus on the ship", ttlSeconds: 3600 });
  const home = createPrincipal(db, { authMethod: "password", label: "Odysseus at Ithaca", ttlSeconds: 3600 });
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Mentor", createdBy: ship.id, ttlSeconds: 3600 });
  const penelope = resolveAmbientPrincipal(db, "proxy", "penelope", "Penelope");
  const telemachus = resolveAmbientPrincipal(db, "proxy", "telemachus", "Telemachus");
  const system = resolveSystemPrincipal(db, { identity: "harbour-watch", label: "Harbour watch" });
  const triggers = () => safetyRecords(db, "ithaca").filter(r => r.kind === "occurrence");
  const collector = (turnId: string, bindingId: string) => createSafetyCollector(db, writes, { turnId, bindingId, sessionId: () => "ithaca",
    backendId: "claude", signal: new AbortController().signal, shellProxied: () => true, brainPath: root });
  /** One finalized occurrence in a turn already bound to the chat. */
  const taint = async (turnId: string, bindingId: string, call: string) => {
    const c = collector(turnId, bindingId); await c.ready("claude", 1);
    await c.begin(call, "WebFetch", { url: "https://ithaca.invalid/suitors" });
    await c.result(call, "WebFetch", "The suitors are in the hall.", true);
    return triggers().at(-1)!.id;
  };
  /** The chat `ithaca`, started on the ship, with one occurrence. */
  const start = async (principalId = ship.id) => {
    const bindingId = crypto.randomUUID();
    await writes.safetyBegin({ turnId: "voyage", bindingId, sessionId: null, principalId, backendId: "claude", at: 0 });
    db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,'claude')").run();
    db.query("INSERT INTO chat_session_owners VALUES('ithaca',?,0)").run(principalId);
    safetyCatalogCreated(db, "ithaca", principalId, "voyage"); await writes.bind("voyage", "ithaca");
    const first = await taint("voyage", bindingId, "A");
    await writes.safetyEnd("voyage");
    return { bindingId, first };
  };
  /** A later turn in `ithaca`, by whoever signed in. */
  const resume = (turnId: string, principalId: string | null, bindingId = crypto.randomUUID()) =>
    writes.safetyBegin({ turnId, bindingId, sessionId: "ithaca", principalId, backendId: "claude", at: 1 }).then(() => bindingId);
  const collections = () => db.query("SELECT turn_id,principal_id,session_id,history_owner_id FROM safety_collections WHERE session_id='ithaca' ORDER BY turn_id")
    .all() as { turn_id: string; principal_id: string | null; session_id: string; history_owner_id: string }[];
  const session = () => db.query("SELECT principal_id,history_owner_id,generation FROM safety_sessions WHERE session_id='ithaca'").get() as
    { principal_id: string | null; history_owner_id: string; generation: string };
  return { root, db, writer, writes, ship, home, agent, penelope, telemachus, system, triggers, taint, start, resume, collections, session,
    async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Which check refused a begin: the write worker's own message, under the retryable refusal. */
async function refusedBy(promise: Promise<unknown>): Promise<string> {
  const error = await rejection(promise) as Error & { cause?: Error };
  return error.cause?.message ?? error.message;
}
/** Every principal that is not the ship's owner account. */
function foreign(f: Fixture) {
  return [["agent", f.agent.id], ["proxy-user", f.penelope.id], ["system", f.system.id], ["unknown-login", "pruned-login"], ["no-principal", null]] as const;
}

test("another owner login continues a chat, and its turn joins the chat's safety history and taint", async () => {
  const f = await fixture(); try {
    const { first } = await f.start();
    expect(f.writes.safety(null, "ithaca").unresolvedCount).toBe(1);
    const bindingId = await f.resume("homecoming", f.home.id);
    expect(f.collections().find(c => c.turn_id === "homecoming"), "SAFETY_SECOND_OWNER_JOINS_THE_CHAT")
      .toEqual({ turn_id: "homecoming", principal_id: f.home.id, session_id: "ithaca", history_owner_id: f.session().history_owner_id });
    // The earlier taint restricts the turn on the other device too.
    const turn = f.writes.safety("homecoming", "ithaca");
    expect(turn.unresolvedCount, "SAFETY_SECOND_OWNER_INHERITS_THE_TAINT").toBe(1);
    expect(turn.earliestUnresolvedId).toBe(first);
    expect(turn.restriction).toBe("restricted");
    const second = await f.taint("homecoming", bindingId, "B");
    expect(f.triggers().map(r => r.id), "SAFETY_SECOND_OWNER_EXTENDS_THE_SAME_HISTORY").toEqual([first, second]);
    expect(f.writes.safety(null, "ithaca").unresolvedCount).toBe(2);
  } finally { await f.close(); }
});

test("another owner login continues a chat whose history already has a dialogue owner", async () => {
  const f = await fixture(); try {
    await f.start();
    // A voice conversation on the ship gave the chat its dialogue owner.
    const owner = openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
    expect(owner.id).toBe(f.session().history_owner_id);
    await f.resume("homecoming", f.home.id);
    expect(f.collections().find(c => c.turn_id === "homecoming")?.history_owner_id, "SAFETY_SECOND_OWNER_KEEPS_THE_DIALOGUE_OWNER").toBe(owner.id);
    expect(f.writes.safety("homecoming", "ithaca").unresolvedCount).toBe(1);
  } finally { await f.close(); }
});

test("a principal of another account is still refused, whichever record names the chat's owner", async () => {
  const f = await fixture(); try {
    await f.start();
    for (const [name, principalId] of foreign(f))
      expect(await refusedBy(f.resume(`intruder-${name}`, principalId)), `SAFETY_FOREIGN_PRINCIPAL_REFUSED: ${name}`).toBe("Safety principal mismatch");
    openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
    for (const [name, principalId] of foreign(f))
      expect(await refusedBy(f.resume(`listener-${name}`, principalId)), `SAFETY_FOREIGN_DIALOGUE_PRINCIPAL_REFUSED: ${name}`).toBe("Safety history ownership mismatch");
    // A refused turn never read or extended the chat's history.
    expect(f.collections().map(c => c.turn_id)).toEqual(["voyage"]);
  } finally { await f.close(); }
});

test("an owner login never takes over a chat bound to an agent or to another proxy user", async () => {
  for (const [name, starter, other] of [["agent", "agent", "ship"], ["proxy user", "penelope", "telemachus"]] as const) {
    const f = await fixture(); try {
      await f.start(f[starter].id);
      expect(await refusedBy(f.resume("takeover", f[other].id)), `SAFETY_ACCOUNT_STAYS_BOUND: ${name}`).toBe("Safety principal mismatch");
      await f.resume("same-principal", f[starter].id);
      expect(f.collections().map(c => c.principal_id), `SAFETY_EXACT_PRINCIPAL_CONTINUES: ${name}`).toEqual([f[starter].id, f[starter].id]);
    } finally { await f.close(); }
  }
});

test("a chat's rows keep the principal that wrote them, and an owner login whose row is gone is unknown", async () => {
  const f = await fixture(); try {
    await f.start();
    const before = { session: f.session(), records: safetyRecords(f.db, "ithaca") };
    await f.resume("homecoming", f.home.id);
    // No rewrite: the chat stays bound to the ship's principal.
    expect(f.session(), "SAFETY_CONTINUATION_REWRITES_NO_BINDING").toEqual(before.session);
    expect(safetyRecords(f.db, "ithaca").slice(0, before.records.length), "SAFETY_CONTINUATION_REWRITES_NO_HISTORY").toEqual(before.records);
    // The login that started the chat still continues it.
    await f.resume("return-to-the-ship", f.ship.id);
    expect(f.collections().map(c => [c.turn_id, c.principal_id])).toEqual([["homecoming", f.home.id], ["return-to-the-ship", f.ship.id], ["voyage", f.ship.id]]);
    // A pruned principal row leaves only an id nobody can vouch for.
    f.db.query("DELETE FROM principals WHERE id=?").run(f.ship.id);
    expect(await refusedBy(f.resume("after-pruning", f.home.id)), "SAFETY_PRUNED_OWNER_IS_UNKNOWN").toBe("Safety principal mismatch");
  } finally { await f.close(); }
});

test("another owner login forks a chat; another account's principal cannot", async () => {
  const f = await fixture(); try {
    await f.start();
    const fork = (turnId: string, principalId: string | null) => f.writes.safetyBegin({ turnId, bindingId: crypto.randomUUID(), sessionId: null, principalId,
      backendId: "claude", sourceSessionId: "ithaca", at: 2 });
    await fork("telemachy", f.home.id);
    expect(f.writes.safety("telemachy", null).unresolvedCount, "SAFETY_SECOND_OWNER_FORK_INHERITS_TAINT").toBe(1);
    for (const [name, principalId] of foreign(f))
      expect(await refusedBy(fork(`stolen-${name}`, principalId)), `SAFETY_FOREIGN_FORK_REFUSED: ${name}`).toBe("Safety fork history ownership mismatch");
  } finally { await f.close(); }
});

test("another owner login reads the chat's safety history; another account's principal cannot", async () => {
  const f = await fixture(); try {
    const { bindingId } = await f.start();
    const history = new SafetyHistory(f.db, () => true, async () => {});
    const page = await history.read(f.home, { sessionId: "ithaca" });
    expect(page.identity, "SAFETY_SECOND_OWNER_READS_THE_CHAT").toEqual({ sessionId: "ithaca", historyOwnerId: f.session().history_owner_id, historyGeneration: "1" });
    expect(page.records.filter(r => r.kind === "occurrence")).toHaveLength(1);
    expect((await history.read(f.home, { turnId: "voyage", bindingId })).identity, "SAFETY_SECOND_OWNER_READS_A_TURN").toEqual(page.identity);
    openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
    expect((await history.read(f.home, { sessionId: "ithaca" })).identity, "SAFETY_SECOND_OWNER_READS_PAST_THE_DIALOGUE_OWNER").toEqual(page.identity);
    for (const principal of [f.agent, f.penelope, f.system]) {
      expect(await rejection(history.read(principal, { sessionId: "ithaca" })), `SAFETY_FOREIGN_READ_REFUSED: ${principal.label}`).toHaveProperty("reason", "unavailable");
      expect(await rejection(history.read(principal, { turnId: "voyage", bindingId })), `SAFETY_FOREIGN_TURN_READ_REFUSED: ${principal.label}`).toHaveProperty("reason", "unavailable");
    }
    history.close();
  } finally { await f.close(); }
});

test("another owner login reviews an occurrence from the first login's turn; another account's principal cannot", async () => {
  const f = await fixture(); try {
    const { first } = await f.start();
    // The ship's voice conversation gave the chat a dialogue owner too.
    openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
    const body = (): SafetyReviewBody => {
      const state = f.writes.safety(null, "ithaca");
      return { version: 1, session: state.session!, occurrenceId: first, expectedEvidenceRevision: state.evidenceRevision, verdict: "safe" };
    };
    for (const principal of [f.agent, f.penelope, f.system]) {
      const actor: SafetyReviewer = { principalId: principal.id, channel: "owner_history" };
      expect(safetyReviewTarget(f.db, body(), principal.id), `SAFETY_FOREIGN_REVIEW_TARGET_REFUSED: ${principal.label}`).toBe("unavailable");
      expect((await f.writes.safetyPrepareReview(body(), actor)).reason, `SAFETY_FOREIGN_REVIEW_REFUSED: ${principal.label}`).toBe("unavailable");
    }
    const actor: SafetyReviewer = { principalId: f.home.id, channel: "owner_history" };
    expect(safetyReviewTarget(f.db, body(), f.home.id), "SAFETY_SECOND_OWNER_REVIEW_TARGET").toBeNull();
    const prepared = await f.writes.safetyPrepareReview(body(), actor);
    expect(prepared.stage, "SAFETY_SECOND_OWNER_PREPARES_A_REVIEW").toBe("prepared");
    const committed = await f.writes.safetyCommitReview(prepared.requestId!, body(), actor);
    expect(committed.stage, "SAFETY_SECOND_OWNER_COMMITS_A_REVIEW").toBe("verdict_committed");
    expect(f.db.query("SELECT principal_id FROM safety_decisions").all(), "SAFETY_VERDICT_NAMES_ITS_REVIEWER").toEqual([{ principal_id: f.home.id }]);
    expect(f.writes.safety(null, "ithaca").restriction).toBe("normal");
  } finally { await f.close(); }
});

test("the decision trigger refuses another account's verdict on each record that names the chat's owner", async () => {
  for (const record of ["session", "collection", "dialogue owner"] as const) {
    const f = await fixture(); try {
      const { first } = await f.start();
      if (record === "dialogue owner") openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
      const { history_owner_id: owner } = f.session();
      // Only the named record still names the ship's login; the others name the agent.
      if (record !== "session") f.db.query("UPDATE safety_sessions SET principal_id=? WHERE session_id='ithaca'").run(f.agent.id);
      if (record !== "collection") f.db.query("UPDATE safety_collections SET principal_id=? WHERE turn_id='voyage'").run(f.agent.id);
      let sequence = 999000;
      const decide = () => f.db.query("INSERT INTO safety_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), first, "ithaca",
        owner, "1", String(sequence++), f.agent.id, crypto.randomUUID(), 1, "safe", "owner_history");
      expect(decide, `SAFETY_DECISION_TRIGGER_CHECKS_THE_${record.toUpperCase()}`).toThrow("safety decision identity or exposure mismatch");
      // Control: with that record the agent's too, the same verdict is admitted.
      if (record === "session") f.db.query("UPDATE safety_sessions SET principal_id=? WHERE session_id='ithaca'").run(f.agent.id);
      if (record === "collection") f.db.query("UPDATE safety_collections SET principal_id=? WHERE turn_id='voyage'").run(f.agent.id);
      if (record === "dialogue owner") f.db.query("UPDATE dialogue_owners SET principal_id=? WHERE id=?").run(f.agent.id, owner);
      decide();
    } finally { await f.close(); }
  }
});

test("only the same principal or two owner logins are one account", async () => {
  const f = await fixture(); try {
    const pairs: [string | null, string | null, boolean][] = [
      [f.ship.id, f.ship.id, true], [f.ship.id, f.home.id, true], [f.home.id, f.ship.id, true],
      [f.agent.id, f.agent.id, true], [f.ship.id, f.agent.id, false], [f.agent.id, f.ship.id, false],
      [f.penelope.id, f.telemachus.id, false], [f.ship.id, f.penelope.id, false], [f.ship.id, f.system.id, false],
      [f.ship.id, "pruned-login", false], ["pruned-login", f.ship.id, false], [f.ship.id, null, false], [null, null, false],
    ];
    for (const [bound, principal, same] of pairs) expect(sameAccount(f.db, bound, principal), `${bound} / ${principal}`).toBe(same);
  } finally { await f.close(); }
});
