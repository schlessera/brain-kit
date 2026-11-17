/** A chat's safety history binds to the account, not the exact login (#3952), and outlives the login that wrote it (#3962). */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { createPrincipal, isUsablePrincipal, PRINCIPAL_RETENTION_MS, prunePrincipals, resolveAmbientPrincipal, resolvePrincipal, resolveSystemPrincipal,
  revokePrincipal, type Principal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { SafetyHistory } from "../src/governance/safety-history";
import { safetyCatalogCreated, safetyRecords } from "../src/governance/safety-store";
import { safetyReviewTarget, type SafetyReviewBody, type SafetyReviewer } from "../src/governance/safety-reviews";
import { durableAccount, sameAccount } from "../src/middleware/account-partition";
import { openDialogue } from "../src/ws/dialogue-storage";
import { rejection } from "./helpers/expect-rejection";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-account-")), path = join(root, "ui.db");
  const db = createUiDb(path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  // Every sign-in mints its own owner principal: one on the ship, one at home.
  const ship = createPrincipal(db, { authMethod: "password", label: "Odysseus on the ship", ttlSeconds: 3600 });
  // The later logins outlive the ship's, so pruning the ship's leaves them.
  const home = createPrincipal(db, { authMethod: "password", label: "Odysseus at Ithaca", ttlSeconds: 7200 });
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Mentor", createdBy: ship.id, ttlSeconds: 7200 });
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
  /** The real cleanup path: the ship's login is revoked, or expires, and is pruned once retention has passed. */
  const prune = (how: "revoked" | "expired") => {
    if (how === "revoked") { revokePrincipal(db, ship.id, Date.now()); prunePrincipals(db, Date.now() + PRINCIPAL_RETENTION_MS + 1); }
    else prunePrincipals(db, ship.expiresAt + PRINCIPAL_RETENTION_MS + 1);
    expect(resolvePrincipal(db, ship.id), `SAFETY_SHIP_LOGIN_PRUNED: ${how}`).toBeNull();
    expect(resolvePrincipal(db, home.id), "SAFETY_HOME_LOGIN_SURVIVES_PRUNING").not.toBeNull();
  };
  /** Only a current, usable login is authorized, as the host checks it. */
  const authorized = (principal: Principal) => { const row = resolvePrincipal(db, principal.id); return row !== null && isUsablePrincipal(row, Date.now()); };
  /** Each record that names the chat's owner, with the account stored beside it. */
  const accounts = () => ({
    session: db.query("SELECT principal_id,principal_account FROM safety_sessions WHERE session_id='ithaca'").get(),
    collections: db.query("SELECT turn_id,principal_id,principal_account FROM safety_collections ORDER BY turn_id").all(),
    owners: db.query("SELECT id,principal_id,principal_account FROM dialogue_owners ORDER BY id").all(),
  });
  return { root, path, db, writer, writes, ship, home, agent, penelope, telemachus, system, triggers, taint, start, resume, collections, session, prune, authorized, accounts,
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

test("a chat's rows keep the principal that wrote them, and a legacy owner login whose row is gone is unknown", async () => {
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
    // History written before #3962 stored no account. Its login still
    // resolves, so another owner login continues it as before.
    f.db.exec("UPDATE safety_sessions SET principal_account=NULL; UPDATE safety_collections SET principal_account=NULL");
    await f.resume("legacy-homecoming", f.home.id);
    // Once that login is pruned, only an id nobody can vouch for is left.
    f.prune("revoked");
    expect(await refusedBy(f.resume("after-pruning", f.home.id)), "SAFETY_PRUNED_LEGACY_OWNER_IS_UNKNOWN").toBe("Safety principal mismatch");
    const history = new SafetyHistory(f.db, f.authorized, async () => {});
    expect(await rejection(history.read(f.home, { sessionId: "ithaca" })), "SAFETY_PRUNED_LEGACY_OWNER_READ_REFUSED").toHaveProperty("reason", "unavailable");
    history.close();
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
      // Only the named record still names the ship's login; the others name
      // the agent, with the agent's account (it has none beyond itself).
      if (record !== "session") f.db.query("UPDATE safety_sessions SET principal_id=?,principal_account=NULL WHERE session_id='ithaca'").run(f.agent.id);
      if (record !== "collection") f.db.query("UPDATE safety_collections SET principal_id=?,principal_account=NULL WHERE turn_id='voyage'").run(f.agent.id);
      let sequence = 999000;
      const decide = () => f.db.query("INSERT INTO safety_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), first, "ithaca",
        owner, "1", String(sequence++), f.agent.id, crypto.randomUUID(), 1, "safe", "owner_history");
      expect(decide, `SAFETY_DECISION_TRIGGER_CHECKS_THE_${record.toUpperCase()}`).toThrow("safety decision identity or exposure mismatch");
      // Control: with that record the agent's too, the same verdict is admitted.
      if (record === "session") f.db.query("UPDATE safety_sessions SET principal_id=?,principal_account=NULL WHERE session_id='ithaca'").run(f.agent.id);
      if (record === "collection") f.db.query("UPDATE safety_collections SET principal_id=?,principal_account=NULL WHERE turn_id='voyage'").run(f.agent.id);
      if (record === "dialogue owner") f.db.query("UPDATE dialogue_owners SET principal_id=?,principal_account=NULL WHERE id=?").run(f.agent.id, owner);
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

/** The review the home login gives on the ship's occurrence. */
function reviewBody(f: Fixture, occurrenceId: string): SafetyReviewBody {
  const state = f.writes.safety(null, "ithaca");
  return { version: 1, session: state.session!, occurrenceId, expectedEvidenceRevision: state.evidenceRevision, verdict: "safe" };
}

for (const [how, voice] of [["revoked", false], ["expired", true]] as const) {
  test(`after the starting login is ${how} and pruned, another owner login continues, binds, reads, forks and reviews the chat${voice ? " and its voice owner" : ""}`, async () => {
    const f = await fixture(); try {
      const { first, bindingId } = await f.start();
      if (voice) openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
      const before = { session: f.session(), records: safetyRecords(f.db, "ithaca"), voyage: f.collections().find(c => c.turn_id === "voyage") };
      f.prune(how);
      // Admission and binding: the turn joins the same history and its taint.
      await f.resume("homecoming", f.home.id);
      expect(f.collections().find(c => c.turn_id === "homecoming"), "SAFETY_PRUNED_OWNER_CHAT_CONTINUES")
        .toEqual({ turn_id: "homecoming", principal_id: f.home.id, session_id: "ithaca", history_owner_id: before.session.history_owner_id });
      const turn = f.writes.safety("homecoming", "ithaca");
      expect([turn.unresolvedCount, turn.earliestUnresolvedId, turn.restriction], "SAFETY_PRUNED_OWNER_TAINT_INHERITED").toEqual([1, first, "restricted"]);
      if (!voice) {
        // A turn begun before it knew its chat binds to it afterwards.
        const landfall = crypto.randomUUID();
        await f.writes.safetyBegin({ turnId: "landfall", bindingId: landfall, sessionId: null, principalId: f.home.id, backendId: "claude", at: 3 });
        await f.writes.bind("landfall", "ithaca");
        expect(f.collections().find(c => c.turn_id === "landfall")?.session_id, "SAFETY_PRUNED_OWNER_LATE_BINDING").toBe("ithaca");
      }
      // Reads, of the chat and of the turn the pruned login wrote.
      const history = new SafetyHistory(f.db, f.authorized, async () => {});
      const page = await history.read(f.home, { sessionId: "ithaca" });
      expect(page.identity, "SAFETY_PRUNED_OWNER_CHAT_READ").toEqual({ sessionId: "ithaca", historyOwnerId: before.session.history_owner_id, historyGeneration: "1" });
      expect(page.records.filter(r => r.kind === "occurrence").map(r => r.id)[0]).toBe(first);
      expect((await history.read(f.home, { turnId: "voyage", bindingId })).identity, "SAFETY_PRUNED_OWNER_TURN_READ").toEqual(page.identity);
      // The stored account is no credential: the pruned login itself is refused.
      expect(await rejection(history.read(f.ship, { sessionId: "ithaca" })), "SAFETY_PRUNED_LOGIN_NOT_AUTHORIZED").toHaveProperty("reason", "unauthorized");
      history.close();
      // Inherited history: a fork carries the taint.
      await f.writes.safetyBegin({ turnId: "telemachy", bindingId: crypto.randomUUID(), sessionId: null, principalId: f.home.id, backendId: "claude", sourceSessionId: "ithaca", at: 4 });
      expect(f.writes.safety("telemachy", null).unresolvedCount, "SAFETY_PRUNED_OWNER_FORK_INHERITS_TAINT").toBe(1);
      // Nothing the ship wrote was rewritten.
      expect(f.session(), "SAFETY_PRUNED_OWNER_ATTRIBUTION_KEPT").toEqual(before.session);
      expect(f.collections().find(c => c.turn_id === "voyage"), "SAFETY_PRUNED_OWNER_COLLECTION_KEPT").toEqual(before.voyage);
      expect(safetyRecords(f.db, "ithaca").slice(0, before.records.length), "SAFETY_PRUNED_OWNER_RECORDS_KEPT").toEqual(before.records);
      // A review decision on the pruned login's occurrence, through the trigger.
      const actor: SafetyReviewer = { principalId: f.home.id, channel: "owner_history" };
      expect(safetyReviewTarget(f.db, reviewBody(f, first), f.home.id), "SAFETY_PRUNED_OWNER_REVIEW_TARGET").toBeNull();
      const prepared = await f.writes.safetyPrepareReview(reviewBody(f, first), actor);
      expect(prepared.stage, "SAFETY_PRUNED_OWNER_REVIEW_PREPARED").toBe("prepared");
      expect((await f.writes.safetyCommitReview(prepared.requestId!, reviewBody(f, first), actor)).stage, "SAFETY_PRUNED_OWNER_REVIEW_COMMITTED").toBe("verdict_committed");
      expect(f.db.query("SELECT occurrence_id,principal_id FROM safety_decisions").all()).toEqual([{ occurrence_id: first, principal_id: f.home.id }]);
      expect(f.writes.safety(null, "ithaca").unresolvedCount).toBe(0);
    } finally { await f.close(); }
  });
}

test("after the starting login is pruned, another account's principal is still refused, and only that chat refuses it", async () => {
  const f = await fixture(); try {
    const { first, bindingId } = await f.start();
    f.prune("revoked");
    for (const [name, principalId] of foreign(f))
      expect(await refusedBy(f.resume(`intruder-${name}`, principalId)), `SAFETY_PRUNED_FOREIGN_REFUSED: ${name}`).toBe("Safety principal mismatch");
    const history = new SafetyHistory(f.db, () => true, async () => {});
    for (const principal of [f.agent, f.penelope, f.system]) {
      expect(await rejection(history.read(principal, { sessionId: "ithaca" })), `SAFETY_PRUNED_FOREIGN_READ_REFUSED: ${principal.label}`).toHaveProperty("reason", "unavailable");
      expect(await rejection(history.read(principal, { turnId: "voyage", bindingId })), `SAFETY_PRUNED_FOREIGN_TURN_READ_REFUSED: ${principal.label}`).toHaveProperty("reason", "unavailable");
      expect(safetyReviewTarget(f.db, reviewBody(f, first), principal.id), `SAFETY_PRUNED_FOREIGN_REVIEW_REFUSED: ${principal.label}`).toBe("unavailable");
    }
    history.close();
    openDialogue(f.db, { conversationId: "argos-voice", principalId: f.home.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
    for (const [name, principalId] of foreign(f))
      expect(await refusedBy(f.resume(`listener-${name}`, principalId)), `SAFETY_PRUNED_FOREIGN_DIALOGUE_REFUSED: ${name}`).toBe("Safety history ownership mismatch");
    // A refused turn never extended the chat, and another chat starts as usual.
    expect(f.collections().map(c => c.turn_id)).toEqual(["voyage"]);
    await f.writes.safetyBegin({ turnId: "phaeacia", bindingId: crypto.randomUUID(), sessionId: null, principalId: f.agent.id, backendId: "claude", at: 5 });
    await f.writes.safetyReady("phaeacia", "claude", 1);
    expect(f.writes.safety("phaeacia", null).restriction, "SAFETY_REFUSAL_CONTAINED_TO_ITS_CHAT").toBe("normal");
  } finally { await f.close(); }
});

test("corrupt or contradictory account evidence matches nobody, and only its chat refuses", async () => {
  for (const [name, principal, account] of [["corrupt", "ship", "admiral"], ["contradicted by a live row", "agent", "owner"]] as const) {
    const f = await fixture(); try {
      const { first } = await f.start();
      f.db.query("UPDATE safety_sessions SET principal_id=?,principal_account=? WHERE session_id='ithaca'").run(f[principal].id, account);
      // Neither another owner login nor the recorded principal itself continues it.
      for (const caller of [f.home, f[principal]])
        expect(await refusedBy(f.resume(`doubt-${caller === f.home ? "home" : principal}`, caller.id)), `SAFETY_BAD_ACCOUNT_REFUSED: ${name} / ${caller.label}`).toBe("Safety principal mismatch");
      const history = new SafetyHistory(f.db, () => true, async () => {});
      expect(await rejection(history.read(f.home, { sessionId: "ithaca" })), `SAFETY_BAD_ACCOUNT_READ_REFUSED: ${name}`).toHaveProperty("reason", "unavailable");
      history.close();
      expect(safetyReviewTarget(f.db, reviewBody(f, first), f.home.id), `SAFETY_BAD_ACCOUNT_REVIEW_REFUSED: ${name}`).toBe("unavailable");
      const { history_owner_id: owner } = f.session();
      expect(() => f.db.query("INSERT INTO safety_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), first, "ithaca", owner, "1", "999000",
        f.home.id, crypto.randomUUID(), 1, "safe", "owner_history"), `SAFETY_BAD_ACCOUNT_TRIGGER_REFUSED: ${name}`).toThrow("safety decision identity or exposure mismatch");
      await f.writes.safetyBegin({ turnId: "phaeacia", bindingId: crypto.randomUUID(), sessionId: null, principalId: f.home.id, backendId: "claude", at: 5 });
      await f.writes.safetyReady("phaeacia", "claude", 1);
      expect(f.writes.safety("phaeacia", null).restriction, `SAFETY_BAD_ACCOUNT_CONTAINED: ${name}`).toBe("normal");
    } finally { await f.close(); }
  }
});

test("the server writes each record's account from its principal's row, never from the turn's input", async () => {
  const f = await fixture(); try {
    await f.start();
    openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
    await f.resume("homecoming", f.home.id);
    // An input that claims an account is ignored: only the principal's row counts.
    for (const [turnId, principalId] of [["mentor", f.agent.id], ["penelope", f.penelope.id], ["watch", f.system.id], ["stranger", "pruned-login"]] as const)
      await f.writes.safetyBegin({ turnId, bindingId: crypto.randomUUID(), sessionId: null, principalId, backendId: "claude", at: 6,
        ...{ principalAccount: "owner", principal_account: "owner", account: "owner" } } as never);
    const { session, collections, owners } = f.accounts();
    expect(session, "SAFETY_SESSION_ACCOUNT_CAPTURED").toEqual({ principal_id: f.ship.id, principal_account: "owner" });
    expect(collections, "SAFETY_COLLECTION_ACCOUNT_CAPTURED").toEqual([
      { turn_id: "homecoming", principal_id: f.home.id, principal_account: "owner" },
      { turn_id: "mentor", principal_id: f.agent.id, principal_account: null },
      { turn_id: "penelope", principal_id: f.penelope.id, principal_account: null },
      { turn_id: "stranger", principal_id: "pruned-login", principal_account: null },
      { turn_id: "voyage", principal_id: f.ship.id, principal_account: "owner" },
      { turn_id: "watch", principal_id: f.system.id, principal_account: null },
    ]);
    expect(owners, "SAFETY_DIALOGUE_OWNER_ACCOUNT_CAPTURED").toEqual([{ id: f.session().history_owner_id, principal_id: f.ship.id, principal_account: "owner" }]);
  } finally { await f.close(); }
});

test("upgrading gives legacy history an account only where a principal row still proves it", async () => {
  const f = await fixture();
  let db = f.db;
  try {
    await f.start();
    openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
    await f.resume("homecoming", f.home.id);
    f.db.query("INSERT INTO dialogue_owners(id,principal_id,coverage,created_at) VALUES('mentor-voice',?,'complete',0)").run(f.agent.id);
    const owner = f.session().history_owner_id, records = safetyRecords(f.db, "ithaca");
    // The tables as they stood before 089, with the ship's login pruned before the upgrade.
    f.db.exec(`DROP TRIGGER safety_decision_identity;
      ALTER TABLE safety_sessions DROP COLUMN principal_account; ALTER TABLE safety_collections DROP COLUMN principal_account;
      ALTER TABLE dialogue_owners DROP COLUMN principal_account; DELETE FROM _migrations WHERE filename='089_safety_durable_account.sql'`);
    f.prune("revoked");
    await f.writer.close(); f.db.close(); db = createUiDb(f.path);
    expect(db.query("SELECT principal_id,principal_account FROM safety_sessions WHERE session_id='ithaca'").get(), "SAFETY_UPGRADE_LOST_PROOF_STAYS_UNKNOWN")
      .toEqual({ principal_id: f.ship.id, principal_account: null });
    expect(db.query("SELECT turn_id,principal_id,principal_account FROM safety_collections ORDER BY turn_id").all(), "SAFETY_UPGRADE_COLLECTION_ACCOUNTS").toEqual([
      { turn_id: "homecoming", principal_id: f.home.id, principal_account: "owner" },
      { turn_id: "voyage", principal_id: f.ship.id, principal_account: null },
    ]);
    expect(db.query("SELECT id,principal_id,principal_account FROM dialogue_owners ORDER BY id='mentor-voice'").all(), "SAFETY_UPGRADE_OWNER_ACCOUNTS").toEqual([
      { id: owner, principal_id: f.ship.id, principal_account: null },
      { id: "mentor-voice", principal_id: f.agent.id, principal_account: null },
    ]);
    expect(safetyRecords(db, "ithaca"), "SAFETY_UPGRADE_REWRITES_NO_HISTORY").toEqual(records);
  } finally { db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a stored account keeps an owner record matching other owner logins once its row is pruned, and nothing else", async () => {
  const f = await fixture(); try {
    expect([f.ship, f.agent, f.penelope, f.system].map(durableAccount), "SAFETY_DURABLE_ACCOUNTS").toEqual(["owner", null, null, null]);
    const ship = (account: string | null) => ({ principalId: f.ship.id, account }), agent = (account: string | null) => ({ principalId: f.agent.id, account });
    const live: [Parameters<typeof sameAccount>[1], string | null, boolean][] = [
      [ship("owner"), f.home.id, true], [ship(null), f.home.id, true], [ship("admiral"), f.home.id, false], [ship("admiral"), f.ship.id, false],
      [agent(null), f.agent.id, true], [agent("owner"), f.agent.id, false], [agent("owner"), f.ship.id, false], [agent(null), f.ship.id, false],
    ];
    for (const [bound, principal, same] of live) expect(sameAccount(f.db, bound, principal), `live ${JSON.stringify(bound)} / ${principal}`).toBe(same);
    f.prune("revoked");
    const pruned: [Parameters<typeof sameAccount>[1], string | null, boolean][] = [
      [ship("owner"), f.home.id, true], [ship(null), f.home.id, false], [f.ship.id, f.home.id, false], [ship("admiral"), f.home.id, false],
      [ship("owner"), f.agent.id, false], [ship("owner"), f.system.id, false], [ship("owner"), "pruned-login", false], [ship("owner"), null, false],
      [{ principalId: null, account: "owner" }, f.home.id, false],
    ];
    for (const [bound, principal, same] of pruned) expect(sameAccount(f.db, bound, principal), `pruned ${JSON.stringify(bound)} / ${principal}`).toBe(same);
  } finally { await f.close(); }
});
