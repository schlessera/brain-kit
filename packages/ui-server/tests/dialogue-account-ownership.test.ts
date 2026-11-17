/**
 * A chat's retained voice history belongs to the account, as its safety
 * history does (#3962): another owner login continues it by voice from another
 * device, after the first login is pruned too (#3963). A live conversation and
 * its epochs stay with the exact login that opened them.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DialogueEvidence } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client";
import { createPrincipal, isUsablePrincipal, PRINCIPAL_RETENTION_MS, prunePrincipals, resolveAmbientPrincipal, resolvePrincipal,
  resolveSystemPrincipal, revokePrincipal, type Principal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { safetyCatalogCreated } from "../src/governance/safety-store";
import { appendDialogue, bindDialogue, closeDialogue, dialogueOwner, hasUnretainedVoice, openDialogue, readDialogue } from "../src/ws/dialogue-storage";
import { resolveChat, type RetireChatResult } from "../src/ws/chat-lifecycle";
import { principalAccount } from "../src/middleware/account-partition";
import { createSessionCatalog, type SessionCatalog } from "../src/ws/session-catalog";
import { createOffloopActivityStore } from "../src/activity/store-writes";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { WsHost } from "../src/ws/host";
import { createWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import { Hono } from "hono";
import type { AppEnv } from "../src/app-env";
import { createSessionRoutes } from "../src/routes/sessions";
import { makeFakeBackend } from "./helpers/fake-backend";
import { fakeLiveProvider } from "./helpers/live-conversation";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-dialogue-account-")), path = join(root, "ui.db");
  const db = createUiDb(path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  // Every sign-in mints its own owner principal: one on the ship, one at home.
  const ship = createPrincipal(db, { authMethod: "password", label: "Odysseus on the ship", ttlSeconds: 3600 });
  const home = createPrincipal(db, { authMethod: "password", label: "Odysseus at Ithaca", ttlSeconds: 7200 });
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Mentor", createdBy: ship.id, ttlSeconds: 7200 });
  const penelope = resolveAmbientPrincipal(db, "proxy", "penelope", "Penelope");
  const system = resolveSystemPrincipal(db, { identity: "harbour-watch", label: "Harbour watch" });
  const foreign = [["agent", agent.id], ["ambient", penelope.id], ["system", system.id], ["unknown", "polyphemus"]] as const;
  /** One retained recognition in the given conversation epoch. */
  const speak = (ownerId: string, principalId: string, conversationId: string, sequence: number, text: string, epoch = 1) => {
    const evidence: DialogueEvidence = { kind: "voice", conversationId, epoch, providerId: "fake-live",
      event: { kind: "unassigned_input_fragment", sequence, text, timing: { kind: "unavailable" }, finalization: "final" } };
    return appendDialogue(db, { ownerId, principalId, generation: 1, identity: `${conversationId}:${epoch}:${sequence}`, evidence });
  };
  const texts = (ownerId: string, principalId: string) =>
    readDialogue(db, principalId, { ownerId })!.records.map(r => r.evidence.kind === "voice" && "text" in r.evidence.event ? r.evidence.event.text : null);
  /** The chat `ithaca`, started by a typed turn on the ship: its safety owner exists before any dialogue. */
  const typed = async (principalId = ship.id) => {
    const bindingId = crypto.randomUUID();
    await writes.safetyBegin({ turnId: "voyage", bindingId, sessionId: null, principalId, backendId: "claude", at: 0 });
    db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,'claude')").run();
    // As the write worker binds it: the creator's durable account from its own row.
    db.query("INSERT INTO chat_session_owners(session_id,principal_id,principal_account,created_at) VALUES('ithaca',?,?,0)").run(principalId, principalAccount(db, principalId));
    safetyCatalogCreated(db, "ithaca", principalId, "voyage"); await writes.bind("voyage", "ithaca");
    await writes.safetyEnd("voyage");
    return (db.query("SELECT history_owner_id FROM safety_sessions WHERE session_id='ithaca'").get() as { history_owner_id: string }).history_owner_id;
  };
  /** The real cleanup path: the ship's login is revoked, or expires, and is pruned once retention has passed. */
  const prune = (how: "revoked" | "expired") => {
    if (how === "revoked") { revokePrincipal(db, ship.id, Date.now()); prunePrincipals(db, Date.now() + PRINCIPAL_RETENTION_MS + 1); }
    else prunePrincipals(db, ship.expiresAt + PRINCIPAL_RETENTION_MS + 1);
    expect(resolvePrincipal(db, ship.id), `DIALOGUE_SHIP_LOGIN_PRUNED: ${how}`).toBeNull();
    expect(resolvePrincipal(db, home.id), "DIALOGUE_HOME_LOGIN_SURVIVES_PRUNING").not.toBeNull();
  };
  const authorized = (principal: Principal) => { const row = resolvePrincipal(db, principal.id); return row !== null && isUsablePrincipal(row, Date.now()); };
  const conversations = () => db.query("SELECT id,owner_id,principal_id,closed FROM dialogue_conversations ORDER BY id").all();
  const owners = () => db.query("SELECT id,principal_id,principal_account,session_id,generation,coverage FROM dialogue_owners ORDER BY id").all();
  return { root, db, writer, writes, ship, home, agent, penelope, system, foreign, speak, texts, typed, prune, authorized, conversations, owners,
    async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const message = (run: () => unknown) => { try { run(); } catch (error) { return (error as Error).message; } return "admitted"; };

test("a second owner login continues a voice-first chat's retained history, keyed by owner or alias", async () => {
  const f = await fixture(); try {
    const owner = openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live" });
    f.speak(owner.id, f.ship.id, "argos-voice", 0, "Set the sail for Ithaca.");
    closeDialogue(f.db, "argos-voice", f.ship.id, 1);
    // The other device opens a new conversation in the same chat.
    const continued = openDialogue(f.db, { conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", historyOwnerId: owner.id });
    expect(continued.id, "DIALOGUE_SECOND_OWNER_CONTINUES_THE_SAME_HISTORY").toBe(owner.id);
    f.speak(continued.id, f.home.id, "ithaca-voice", 0, "Unbar the hall doors.");
    expect(f.texts(owner.id, f.home.id), "DIALOGUE_SECOND_OWNER_READS_THE_WHOLE_HISTORY").toEqual(["Set the sail for Ithaca.", "Unbar the hall doors."]);
    expect(f.texts(owner.id, f.ship.id), "DIALOGUE_FIRST_OWNER_READS_THE_CONTINUATION").toEqual(["Set the sail for Ithaca.", "Unbar the hall doors."]);
    // The adoption that follows a first typed task binds it, from either login.
    const bound = bindDialogue(f.db, "ithaca-voice", f.home.id, "ithaca");
    expect(bound?.id, "DIALOGUE_SECOND_OWNER_BINDS_THE_PROVISIONAL_HISTORY").toBe(owner.id);
    expect(dialogueOwner(f.db, { sessionId: "ithaca" }, f.ship.id)?.id, "DIALOGUE_SESSION_LOOKUP_FROM_EITHER_LOGIN").toBe(owner.id);
    expect(dialogueOwner(f.db, { ownerId: "argos-voice" }, f.home.id)?.id).toBe(owner.id);
    // Attribution: the history keeps the login that started it, and each conversation its own.
    expect(f.owners(), "DIALOGUE_ATTRIBUTION_IS_NOT_REWRITTEN").toEqual([{ id: owner.id, principal_id: f.ship.id, principal_account: "owner", session_id: "ithaca", generation: 1, coverage: "complete" }]);
    expect(f.conversations()).toEqual([
      { id: "argos-voice", owner_id: owner.id, principal_id: f.ship.id, closed: 1 },
      { id: "ithaca-voice", owner_id: owner.id, principal_id: f.home.id, closed: 0 },
    ]);
  } finally { await f.close(); }
});

test("a typed-first chat's first voice from another owner login uses the chat's canonical safety owner", async () => {
  const f = await fixture(); try {
    const safetyOwner = await f.typed();
    const owner = openDialogue(f.db, { conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    expect(owner.id, "DIALOGUE_TYPED_FIRST_REUSES_THE_SAFETY_OWNER").toBe(safetyOwner);
    // The owner row is the history's first voice login, under the owner account.
    expect(f.owners()).toEqual([{ id: safetyOwner, principal_id: f.home.id, principal_account: "owner", session_id: "ithaca", generation: 1, coverage: "complete" }]);
    const again = openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    expect(again.id, "DIALOGUE_TYPED_FIRST_THEN_FIRST_LOGIN").toBe(safetyOwner);
  } finally { await f.close(); }
});

test("another account's typed chat is refused, never forked into a second voice owner", async () => {
  const f = await fixture(); try {
    await f.typed(f.agent.id);
    expect(message(() => openDialogue(f.db, { conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" })),
      "DIALOGUE_FOREIGN_SAFETY_OWNER_REFUSED").toBe("Dialogue ownership mismatch");
    expect(f.owners()).toEqual([]);expect(f.conversations()).toEqual([]);
  } finally { await f.close(); }
});

for (const how of ["revoked", "expired"] as const) test(`the history outlives the login that wrote it once it is ${how} and pruned`, async () => {
  const f = await fixture(); try {
    const owner = openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    f.speak(owner.id, f.ship.id, "argos-voice", 0, "Set the sail for Ithaca.");
    closeDialogue(f.db, "argos-voice", f.ship.id, 1);
    f.prune(how);
    expect(f.authorized(f.ship), "DIALOGUE_PRUNED_LOGIN_STAYS_INVALID").toBe(false);
    expect(f.authorized(f.home)).toBe(true);
    expect(f.texts(owner.id, f.home.id), "DIALOGUE_PRUNED_ORIGIN_READS").toEqual(["Set the sail for Ithaca."]);
    const continued = openDialogue(f.db, { conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    expect(continued.id, "DIALOGUE_PRUNED_ORIGIN_CONTINUES").toBe(owner.id);
    f.speak(continued.id, f.home.id, "ithaca-voice", 0, "Unbar the hall doors.");
    expect(f.texts(owner.id, f.home.id)).toEqual(["Set the sail for Ithaca.", "Unbar the hall doors."]);
    // Principal retention is unchanged, and the stored account is no credential for anyone else.
    for (const [name, principalId] of f.foreign)
      expect(message(() => readDialogue(f.db, principalId, { ownerId: owner.id })), `DIALOGUE_FOREIGN_READ_REFUSED_AFTER_PRUNING: ${name}`).toBe("Dialogue ownership mismatch");
  } finally { await f.close(); }
});

test("other accounts and unknown identities are refused before any history moves", async () => {
  const f = await fixture(); try {
    const owner = openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    f.speak(owner.id, f.ship.id, "argos-voice", 0, "Set the sail for Ithaca.");
    const before = { owners: f.owners(), conversations: f.conversations() };
    for (const [name, principalId] of f.foreign) {
      for (const target of [{ sessionId: "ithaca" }, { historyOwnerId: owner.id }])
        expect(message(() => openDialogue(f.db, { conversationId: `intruder-${name}`, principalId, epoch: 1, providerId: "fake-live", ...target })),
          `DIALOGUE_FOREIGN_OPEN_REFUSED: ${name} ${Object.keys(target)[0]}`).toMatch(/^Dialogue (ownership mismatch|provisional owner unavailable)$/);
      expect(message(() => readDialogue(f.db, principalId, { sessionId: "ithaca" })), `DIALOGUE_FOREIGN_READ_REFUSED: ${name}`).toBe("Dialogue ownership mismatch");
      expect(message(() => f.speak(owner.id, principalId, "argos-voice", 9, "Bind them to the mast.")), `DIALOGUE_FOREIGN_WRITE_REFUSED: ${name}`).toBe("Dialogue ownership mismatch");
      expect(hasUnretainedVoice(f.db, principalId, "ithaca")).toBe(false);
    }
    expect({ owners: f.owners(), conversations: f.conversations() }, "DIALOGUE_REFUSALS_MOVE_NOTHING").toEqual(before);
    expect(f.texts(owner.id, f.ship.id)).toEqual(["Set the sail for Ithaca."]);
  } finally { await f.close(); }
});

test("an agent's or an ambient principal's voice history stays only its own", async () => {
  const f = await fixture(); try {
    for (const starter of [f.agent, f.penelope]) {
      const owner = openDialogue(f.db, { conversationId: `${starter.kind}-voice`, principalId: starter.id, epoch: 1, providerId: "fake-live" });
      expect(f.db.query("SELECT principal_account FROM dialogue_owners WHERE id=?").get(owner.id)).toEqual({ principal_account: null });
      for (const other of [f.ship, f.home, starter === f.agent ? f.penelope : f.agent])
        expect(message(() => openDialogue(f.db, { conversationId: `${other.id}-takeover`, principalId: other.id, epoch: 1, providerId: "fake-live", historyOwnerId: owner.id })),
          `DIALOGUE_ACCOUNT_STAYS_BOUND: ${starter.kind} ${other.kind}`).toBe("Dialogue ownership mismatch");
      expect(readDialogue(f.db, starter.id, { ownerId: owner.id })!.ownerId, `DIALOGUE_EXACT_PRINCIPAL_CONTINUES: ${starter.kind}`).toBe(owner.id);
    }
  } finally { await f.close(); }
});

test("unknown, corrupt and contradictory ownership evidence refuses within its own chat", async () => {
  const f = await fixture(); try {
    const legacy = openDialogue(f.db, { conversationId: "legacy-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live" });
    const corrupt = openDialogue(f.db, { conversationId: "corrupt-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live" });
    const contradicted = openDialogue(f.db, { conversationId: "contradicted-voice", principalId: f.agent.id, epoch: 1, providerId: "fake-live" });
    const healthy = openDialogue(f.db, { conversationId: "healthy-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live" });
    // A legacy row whose login was already pruned before it stored an account.
    f.db.query("UPDATE dialogue_owners SET principal_account=NULL WHERE id=?").run(legacy.id);
    f.prune("revoked");
    f.db.query("UPDATE dialogue_owners SET principal_account='admiral' WHERE id=?").run(corrupt.id);
    f.db.query("UPDATE dialogue_owners SET principal_account='owner' WHERE id=?").run(contradicted.id);
    expect(message(() => openDialogue(f.db, { conversationId: "legacy-continued", principalId: f.home.id, epoch: 1, providerId: "fake-live", historyOwnerId: legacy.id })),
      "DIALOGUE_PRUNED_WITHOUT_EVIDENCE_IS_UNKNOWN").toBe("Dialogue ownership mismatch");
    expect(message(() => readDialogue(f.db, f.home.id, { ownerId: corrupt.id })), "DIALOGUE_CORRUPT_EVIDENCE_MATCHES_NOBODY").toBe("Dialogue ownership mismatch");
    expect(message(() => readDialogue(f.db, f.home.id, { ownerId: contradicted.id })), "DIALOGUE_CONTRADICTED_EVIDENCE_REFUSED").toBe("Dialogue ownership mismatch");
    expect(message(() => readDialogue(f.db, f.agent.id, { ownerId: contradicted.id })), "DIALOGUE_CONTRADICTED_EVIDENCE_REFUSES_ITS_OWN_PRINCIPAL").toBe("Dialogue ownership mismatch");
    // The refusal is that chat's; another chat of the account stays usable.
    expect(readDialogue(f.db, f.home.id, { ownerId: healthy.id })!.ownerId, "DIALOGUE_UNRELATED_CHAT_USABLE").toBe(healthy.id);
    // A stale generation still refuses after cross-login continuation.
    const shared = openDialogue(f.db, { conversationId: "shared-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live" });
    f.db.query("UPDATE dialogue_owners SET generation=2 WHERE id=?").run(shared.id);
    expect(message(() => readDialogue(f.db, f.home.id, { ownerId: shared.id, generation: 1 })), "DIALOGUE_STALE_GENERATION_REFUSED").toBe("Dialogue generation changed");
    // No evidence was rewritten to make it fit.
    expect(f.db.query("SELECT id,principal_account FROM dialogue_owners WHERE id IN (?,?,?) ORDER BY id").all(legacy.id, corrupt.id, contradicted.id)).toEqual(
      [{ id: contradicted.id, principal_account: "owner" }, { id: corrupt.id, principal_account: "admiral" }, { id: legacy.id, principal_account: null }].sort((a, b) => a.id < b.id ? -1 : 1));
  } finally { await f.close(); }
});

test("unretained or unfinished voice stays honestly legacy or partial after another login continues", async () => {
  const f = await fixture(); try {
    // The ship's voice recovery before journals existed, then the ship is pruned.
    f.db.query("INSERT INTO conversation_epochs(id,principal_id,epoch,session_id,updated_at) VALUES('old-voice',?,1,'ithaca',0)").run(f.ship.id);
    expect(hasUnretainedVoice(f.db, f.home.id, "ithaca"), "DIALOGUE_ACCOUNT_LEGACY_EVIDENCE_COUNTS").toBe(true);
    f.prune("expired");
    expect(hasUnretainedVoice(f.db, f.home.id, "ithaca"), "DIALOGUE_PRUNED_LOGIN_LEGACY_STAYS_LEGACY").toBe(true);
    const owner = openDialogue(f.db, { conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    expect(owner.coverage, "DIALOGUE_CROSS_LOGIN_LEGACY_NOT_COMPLETE").toBe("legacy");
    // An unclosed earlier epoch of another login is interruption evidence for a new open.
    const pylos = openDialogue(f.db, { conversationId: "pylos-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "pylos" });
    const other = createPrincipal(f.db, { authMethod: "password", label: "Odysseus at Pylos", ttlSeconds: 7200 });
    const reopened = openDialogue(f.db, { conversationId: "pylos-again", principalId: other.id, epoch: 1, providerId: "fake-live", sessionId: "pylos" });
    expect([reopened.id, reopened.coverage], "DIALOGUE_OTHER_LOGINS_UNCLOSED_EPOCH_IS_PARTIAL").toEqual([pylos.id, "partial"]);
  } finally { await f.close(); }
});

test("sharing the history gives no authority over another login's conversation or epoch", async () => {
  const f = await fixture(); try {
    const owner = openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    expect(message(() => openDialogue(f.db, { conversationId: "argos-voice", principalId: f.home.id, epoch: 2, providerId: "fake-live", sessionId: "ithaca" })),
      "DIALOGUE_OTHER_LOGIN_CANNOT_REOPEN_A_CONVERSATION").toBe("Dialogue conversation principal mismatch");
    expect(message(() => closeDialogue(f.db, "argos-voice", f.home.id, 1, true)), "DIALOGUE_OTHER_LOGIN_CANNOT_CLOSE_AN_EPOCH").toBe("Dialogue conversation principal mismatch");
    expect(f.conversations(), "DIALOGUE_REFUSED_CONTROL_CHANGES_NOTHING").toEqual([{ id: "argos-voice", owner_id: owner.id, principal_id: f.ship.id, closed: 0 }]);
    expect(f.owners()).toMatchObject([{ coverage: "complete" }]);
    closeDialogue(f.db, "argos-voice", f.ship.id, 1);
    expect(f.conversations()).toMatchObject([{ closed: 1 }]);
  } finally { await f.close(); }
});

/** The real deletion path (#4138): admission on the catalog, commit on the fixture's write worker. */
const catalogOf = (f: Awaited<ReturnType<typeof fixture>>) =>
  createSessionCatalog(() => f.db, undefined, undefined, { writer: f.writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(f.db, f.writer) });
const retire = (catalog: SessionCatalog, principalId: string, operationId: string, sessionId = "ithaca"): Promise<RetireChatResult> =>
  catalog.retireChat!({ operationId, principalId, target: { sessionId }, expected: { backendId: "claude", generation: 1 }, removableBackends: ["claude"], at: Date.now() }, () => false);
const retireProvisional = (catalog: SessionCatalog, principalId: string, operationId: string, ownerId: string): Promise<RetireChatResult> =>
  catalog.retireChat!({ operationId, principalId, target: { ownerId }, expected: { backendId: null, generation: 1 }, removableBackends: [], at: Date.now() }, () => false);
const UNAVAILABLE = { status: "refused", reason: "unavailable" } as const, UNAUTHORIZED = { status: "refused", reason: "unauthorized" } as const;
const settle = (p: Promise<unknown>) => p.then(() => "written", (e: Error) => e.message);
/**
 * The chat `ithaca`, typed on the ship, then continued by voice from the ship
 * and from home: every ownership record a deletion consults, written by the
 * real catalog writers. Two logins of one account, and no other.
 */
async function sharedChat(f: Awaited<ReturnType<typeof fixture>>, catalog: SessionCatalog) {
  await f.typed();
  for (const [conversationId, principal] of [["argos-voice", f.ship], ["ithaca-voice", f.home]] as const) {
    await catalog.dialogueOpen!({ conversationId, principalId: principal.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    await catalog.saveConversationEpoch!({ id: conversationId, principalId: principal.id, epoch: 1, sessionId: "ithaca" });
    await catalog.dialogueClose!(conversationId, principal.id, 1, false);
  }
  await catalog.settled!();
}
/** Another chat of the account, from the home login alone: a refusal elsewhere must not reach it. */
async function unrelatedChat(f: Awaited<ReturnType<typeof fixture>>, catalog: SessionCatalog) {
  catalog.persistSessionStub("pylos", "Ask Nestor for news", null, "claude", f.home.id);
  await catalog.dialogueOpen!({ conversationId: "pylos-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "pylos" });
  await catalog.saveConversationEpoch!({ id: "pylos-voice", principalId: f.home.id, epoch: 1, sessionId: "pylos" });
  await catalog.settled!();
}
const evidence = (db: Awaited<ReturnType<typeof fixture>>["db"]) => ({
  owners: db.query("SELECT id,principal_id,principal_account FROM dialogue_owners ORDER BY id").all(),
  epochs: db.query("SELECT id,principal_id,principal_account FROM conversation_epochs ORDER BY id").all(),
  creators: db.query("SELECT session_id,principal_id,principal_account FROM chat_session_owners ORDER BY session_id").all(),
});
const lifecycles = (db: Awaited<ReturnType<typeof fixture>>["db"]) => db.query("SELECT id,principal_id,operation_id FROM chat_lifecycles ORDER BY id").all();

for (const deleter of ["ship", "home", "a third login"] as const) test(`a chat two owner logins used by voice is deleted by ${deleter}, under its own operation`, async () => {
  const f = await fixture(); const catalog = catalogOf(f); try {
    await sharedChat(f, catalog);
    // The real writers stored each record's durable account beside its login.
    expect(evidence(f.db), "DELETION_RECORDS_CARRY_DURABLE_ACCOUNTS").toEqual({
      owners: [{ id: expect.any(String), principal_id: f.ship.id, principal_account: "owner" }],
      epochs: [{ id: "argos-voice", principal_id: f.ship.id, principal_account: "owner" }, { id: "ithaca-voice", principal_id: f.home.id, principal_account: "owner" }],
      creators: [{ session_id: "ithaca", principal_id: f.ship.id, principal_account: "owner" }] });
    const before = evidence(f.db);
    const third = createPrincipal(f.db, { authMethod: "passkey", label: "Odysseus in the hall", ttlSeconds: 7200 });
    const caller = deleter === "ship" ? f.ship : deleter === "home" ? f.home : third;
    const bystander = caller === f.home ? f.ship : f.home;
    const result = await retire(catalog, caller.id, "retire-ithaca");
    expect(result, `DELETION_ADMITS_THE_ACCOUNTS_LOGIN: ${deleter}`).toMatchObject({ status: "retired", lifecycleId: "ithaca", operationId: "retire-ithaca", generation: 2,
      identities: { sessions: ["ithaca"], conversations: ["argos-voice", "ithaca-voice"] } });
    // The operation belongs to the login that asked; no record is reassigned.
    expect(lifecycles(f.db), "DELETION_OPERATION_IS_THE_CALLERS").toEqual([{ id: "ithaca", principal_id: caller.id, operation_id: "retire-ithaca" }]);
    expect(evidence(f.db), "DELETION_KEEPS_ORIGINAL_ATTRIBUTION").toEqual(before);
    expect(await catalog.chatRetirement!("retire-ithaca", caller.id), "DELETION_RECEIPT_READS_FOR_ITS_INITIATOR").toMatchObject({ status: "retired" });
    expect(await catalog.chatRetirement!("retire-ithaca", bystander.id), "DELETION_RECEIPT_IS_NOT_ANOTHER_LOGINS").toBeNull();
    expect(await retire(catalog, bystander.id, "retire-ithaca"), "DELETION_HANDLE_IS_NOT_ANOTHER_LOGINS").toEqual(UNAVAILABLE);
    // The fences hold for every login of the account.
    expect(await retire(catalog, bystander.id, "retire-ithaca-again"), "DELETION_RETIRED_CHAT_STAYS_RETIRED").toEqual(UNAVAILABLE);
    expect(await settle(catalog.dialogueOpen!({ conversationId: "late-voice", principalId: bystander.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" })),
      "DELETION_FENCE_REFUSES_THE_OTHER_LOGIN").toContain("retired");
    expect(await settle(catalog.saveConversationEpoch!({ id: "ithaca-voice", principalId: f.home.id, epoch: 2, sessionId: "ithaca" })), "DELETION_EPOCH_NEVER_REOPENS").toContain("retired");
    expect(lifecycles(f.db)).toHaveLength(1);
  } finally { await catalog.settled!(); await f.close(); }
});

for (const how of ["revoked", "expired"] as const) test(`the remaining login deletes the shared chat once the other is ${how} and pruned`, async () => {
  const f = await fixture(); const catalog = catalogOf(f); try {
    await sharedChat(f, catalog);
    f.prune(how);
    // The pruned login proves its records' account only through what was stored.
    expect(await retire(catalog, f.ship.id, "retire-by-the-pruned"), "DELETION_PRUNED_CALLER_GAINS_NOTHING").toEqual(UNAUTHORIZED);
    expect(await retire(catalog, f.home.id, "retire-ithaca"), "DELETION_DURABLE_EVIDENCE_OUTLIVES_PRUNING").toMatchObject({ status: "retired", generation: 2 });
    expect(lifecycles(f.db)).toEqual([{ id: "ithaca", principal_id: f.home.id, operation_id: "retire-ithaca" }]);
  } finally { await catalog.settled!(); await f.close(); }
});

test("a caller that is not a current owner login is refused, whatever the chat's records say", async () => {
  const f = await fixture(); const catalog = catalogOf(f); try {
    await sharedChat(f, catalog);
    for (const [name, principalId] of f.foreign)
      expect(await retire(catalog, principalId, `retire-by-${name}`), `DELETION_REFUSES_CALLER: ${name}`).toEqual(UNAUTHORIZED);
    revokePrincipal(f.db, f.home.id, Date.now());
    expect(await retire(catalog, f.home.id, "retire-by-revoked"), "DELETION_REFUSES_CALLER: revoked").toEqual(UNAUTHORIZED);
    // Its login lapsed, but retention has not pruned its row yet.
    f.db.query("UPDATE principals SET expires_at=? WHERE id=?").run(Date.now() - 1, f.ship.id);
    expect([f.authorized(f.ship), resolvePrincipal(f.db, f.ship.id) !== null]).toEqual([false, true]);
    expect(await retire(catalog, f.ship.id, "retire-by-expired"), "DELETION_REFUSES_CALLER: expired").toEqual(UNAUTHORIZED);
    expect(lifecycles(f.db), "DELETION_NOTHING_RETIRED").toEqual([]);
  } finally { await catalog.settled!(); await f.close(); }
});

/**
 * Each case leaves one ownership record of the shared chat unproven. The
 * caller is a current owner login every time; only the evidence differs.
 */
const UNPROVEN: [string, (f: Awaited<ReturnType<typeof fixture>>) => void][] = [
  ["a pruned voice epoch with no stored account", f => { f.db.query("UPDATE conversation_epochs SET principal_account=NULL WHERE id='argos-voice'").run(); f.prune("revoked"); }],
  ["a pruned creation binding with no stored account", f => { f.db.query("UPDATE chat_session_owners SET principal_account=NULL WHERE session_id='ithaca'").run(); f.prune("revoked"); }],
  ["a pruned dialogue owner with no stored account", f => { f.db.query("UPDATE dialogue_owners SET principal_account=NULL WHERE session_id='ithaca'").run(); f.prune("expired"); }],
  ["a corrupt voice epoch account", f => { f.db.query("UPDATE conversation_epochs SET principal_account='admiral' WHERE id='ithaca-voice'").run(); }],
  ["a corrupt creation binding account", f => { f.db.query("UPDATE chat_session_owners SET principal_account='admiral' WHERE session_id='ithaca'").run(); }],
  ["a corrupt dialogue owner account", f => { f.db.query("UPDATE dialogue_owners SET principal_account='admiral' WHERE session_id='ithaca'").run(); }],
  ["an agent epoch claiming the owner account", f => { f.db.query("INSERT INTO conversation_epochs(id,principal_id,principal_account,epoch,session_id,updated_at) VALUES('mentor-voice',?,'owner',1,'ithaca',0)").run(f.agent.id); }],
  ["an agent's voice epoch", f => { f.db.query("INSERT INTO conversation_epochs(id,principal_id,principal_account,epoch,session_id,updated_at) VALUES('mentor-voice',?,NULL,1,'ithaca',0)").run(f.agent.id); }],
  ["an ambient principal's voice epoch", f => { f.db.query("INSERT INTO conversation_epochs(id,principal_id,principal_account,epoch,session_id,updated_at) VALUES('penelope-voice',?,NULL,1,'ithaca',0)").run(f.penelope.id); }],
  ["a system principal's voice epoch", f => { f.db.query("INSERT INTO conversation_epochs(id,principal_id,principal_account,epoch,session_id,updated_at) VALUES('watch-voice',?,NULL,1,'ithaca',0)").run(f.system.id); }],
  ["an unknown principal's voice epoch", f => { f.db.query("INSERT INTO conversation_epochs(id,principal_id,principal_account,epoch,session_id,updated_at) VALUES('cyclops-voice','polyphemus',NULL,1,'ithaca',0)").run(); }],
  ["an unknown principal claiming the owner account", f => { f.db.query("INSERT INTO conversation_epochs(id,principal_id,principal_account,epoch,session_id,updated_at) VALUES('cyclops-voice','polyphemus','admiral',1,'ithaca',0)").run(); }],
];
for (const [name, unprove] of UNPROVEN) test(`deletion refuses within the chat for ${name}, and moves nothing`, async () => {
  const f = await fixture(); const catalog = catalogOf(f); try {
    await sharedChat(f, catalog);
    await unrelatedChat(f, catalog);
    unprove(f);
    const before = evidence(f.db);
    for (const caller of [f.home, f.ship].filter(f.authorized))
      expect(await retire(catalog, caller.id, `retire-ithaca-${caller.id}`), `DELETION_UNPROVEN_OWNERSHIP_REFUSES: ${name}`).toEqual(UNAVAILABLE);
    expect(lifecycles(f.db), `DELETION_UNPROVEN_RETIRES_NOTHING: ${name}`).toEqual([]);
    expect(evidence(f.db), `DELETION_UNPROVEN_REWRITES_NOTHING: ${name}`).toEqual(before);
    // The refusal is that chat's: the account's other chat is still deleted.
    expect(await retire(catalog, f.home.id, "retire-pylos", "pylos"), `DELETION_UNRELATED_CHAT_USABLE: ${name}`).toMatchObject({ status: "retired", lifecycleId: "pylos" });
  } finally { await catalog.settled!(); await f.close(); }
});

test("another login of the account cannot write voice evidence into an epoch it did not open", async () => {
  const f = await fixture(); try {
    const owner = openDialogue(f.db, { conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    openDialogue(f.db, { conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    const into = (conversationId: string, principalId: string, kind: "voice" | "voice_interruption" | "voice_end", n: number) => {
      const scope = { conversationId, epoch: 1, providerId: "fake-live" };
      const evidence: DialogueEvidence = kind === "voice"
        ? { kind, ...scope, event: { kind: "unassigned_input_fragment", sequence: n, text: "Bind me to the mast.", timing: { kind: "unavailable" }, finalization: "final" } }
        : kind === "voice_interruption" ? { kind, ...scope } : { kind, ...scope, startedAt: 0, endedAt: 1 };
      return message(() => appendDialogue(f.db, { ownerId: owner.id, principalId, generation: 1, identity: `${conversationId}:${kind}:${principalId}:${n}`, evidence }));
    };
    for (const [n, kind] of (["voice", "voice_interruption", "voice_end"] as const).entries()) {
      expect(into("argos-voice", f.home.id, kind, n), `DIALOGUE_OTHER_LOGIN_CANNOT_WRITE_AN_EPOCH: ${kind}`).toBe("Dialogue source scope mismatch");
      expect(into("ithaca-voice", f.ship.id, kind, n), `DIALOGUE_FIRST_LOGIN_CANNOT_WRITE_THE_SECONDS_EPOCH: ${kind}`).toBe("Dialogue source scope mismatch");
    }
    expect(f.db.query("SELECT COUNT(*) AS n FROM dialogue_records").get(), "DIALOGUE_REFUSED_WRITES_LEAVE_NO_RECORD").toEqual({ n: 0 });
    // Each login writes its own epoch, into the one shared history.
    for (const [n, kind] of (["voice", "voice_interruption", "voice_end"] as const).entries()) {
      expect(into("argos-voice", f.ship.id, kind, n), `DIALOGUE_OPENING_LOGIN_WRITES: ${kind}`).toBe("admitted");
      expect(into("ithaca-voice", f.home.id, kind, n)).toBe("admitted");
    }
    expect(f.db.query("SELECT COUNT(*) AS n FROM dialogue_records WHERE owner_id=?").get(owner.id)).toEqual({ n: 6 });
  } finally { await f.close(); }
});

test("another login's adoption of a live provisional history keeps its live identity and healthy coverage", async () => {
  const f = await fixture();
  const { DialogueJournal } = await import("../src/ws/dialogue");
  const catalog = createSessionCatalog(() => f.db, undefined, undefined, { writer: f.writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(f.db, f.writer) });
  const pages: { ownerId: string; coverage: string }[] = [];
  const journal = new DialogueJournal(catalog, page => pages.push({ ownerId: page.ownerId, coverage: page.coverage }), () => {});
  try {
    // The home login already has this chat's session history.
    const home = await catalog.dialogueOpen!({ conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    await catalog.dialogueClose!("ithaca-voice", f.home.id, 1, false);
    // The ship login is live in a host-only history.
    const ship = await journal.open({ conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live" });
    expect(ship!.id).toBe("argos-voice");
    // The home login's typed turn adopts it into the session.
    journal.adoptTurn("homecoming", ship!.id, f.home.id);
    journal.backend({ type: "session_info", sessionId: "ithaca", turnId: "homecoming", isNew: false } as never);
    // The live epoch keeps speaking while the adoption is in flight.
    const during = { kind: "voice" as const, conversationId: "argos-voice", epoch: 1, providerId: "fake-live",
      event: { kind: "unassigned_input_fragment" as const, sequence: 1, text: "Hold the course.", timing: { kind: "unavailable" as const }, finalization: "final" as const } };
    expect(journal.voice("argos-voice", during, () => {}), "DIALOGUE_ADOPTION_KEEPS_LIVE_INGRESS").toBe(true);
    await journal.settled();
    expect(f.db.query("SELECT owner_id FROM dialogue_aliases WHERE id='argos-voice'").get(), "DIALOGUE_CROSS_LOGIN_ADOPTION_MERGED").toEqual({ owner_id: home.id });
    expect((await catalog.dialogueRead!(f.home.id, { sessionId: "ithaca" }))!.coverage, "DIALOGUE_CROSS_LOGIN_ADOPTION_STAYS_HEALTHY").toBe("complete");
    expect(f.owners(), "DIALOGUE_CROSS_LOGIN_ADOPTION_DB_COMPLETE").toMatchObject([{ id: home.id, coverage: "complete" }]);
    // The live epoch's journal references now name the canonical owner.
    expect(ship!.id, "DIALOGUE_CROSS_LOGIN_ADOPTION_UPDATES_LIVE_OWNER").toBe(home.id);
    const e = { kind: "voice" as const, conversationId: "argos-voice", epoch: 1, providerId: "fake-live",
      event: { kind: "unassigned_input_fragment" as const, sequence: 0, text: "Steer for the hall.", timing: { kind: "unavailable" as const }, finalization: "final" as const } };
    expect(journal.voice("argos-voice", e, () => {})).toBe(true);
    await journal.settled();
    expect(pages.at(-1), "DIALOGUE_CROSS_LOGIN_ADOPTION_PUBLISHES_CANONICAL_OWNER").toEqual({ ownerId: home.id, coverage: "complete" });
    expect(f.db.query("SELECT COUNT(*) AS n FROM dialogue_records WHERE owner_id=? AND payload LIKE '%argos-voice%'").get(home.id), "DIALOGUE_ADOPTION_RETAINS_BOTH_UTTERANCES").toEqual({ n: 2 });
    journal.close("argos-voice", f.ship.id, 1);
    await journal.settled();
    expect((await catalog.dialogueRead!(f.ship.id, { sessionId: "ithaca" }))!.coverage).toBe("complete");
  } finally { await journal.settled().catch(() => {}); await catalog.settled!(); await f.close(); }
});

test("the catalog keeps live-epoch authority with the login that opened it", async () => {
  const f = await fixture();
  const catalog = createSessionCatalog(() => f.db, undefined, undefined, { writer: f.writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(f.db, f.writer) });
  try {
    const owner = await catalog.dialogueOpen!({ conversationId: "argos-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    // Two healthy live conversations of the account on one history: neither is interruption.
    const continued = await catalog.dialogueOpen!({ conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    expect(continued.id).toBe(owner.id);
    expect(f.owners(), "DIALOGUE_CROSS_LOGIN_SIBLING_IS_NOT_INTERRUPTION").toMatchObject([{ coverage: "complete" }]);
    expect((await catalog.dialogueRead!(f.home.id, { sessionId: "ithaca" }))!.coverage, "DIALOGUE_CROSS_LOGIN_READ_COMPLETE").toBe("complete");
    // The second login's close of the first login's epoch is refused and leaves it live.
    let refused: unknown; try { await catalog.dialogueClose!("argos-voice", f.home.id, 1, false); } catch (error) { refused = error; }
    expect(refused, "DIALOGUE_CATALOG_REFUSES_FOREIGN_EPOCH_CLOSE").toBeInstanceOf(Error);
    expect((await catalog.dialogueRead!(f.ship.id, { sessionId: "ithaca" }))!.coverage, "DIALOGUE_FIRST_EPOCH_STILL_LIVE").toBe("complete");
    // Each login closes its own epoch.
    await catalog.dialogueClose!("ithaca-voice", f.home.id, 1, false);
    await catalog.dialogueClose!("argos-voice", f.ship.id, 1, false);
    expect(f.conversations()).toMatchObject([{ id: "argos-voice", closed: 1 }, { id: "ithaca-voice", closed: 1 }]);
    expect(catalog.dialogueAudience!(owner, f.home.id), "DIALOGUE_AUDIENCE_IS_THE_ACCOUNT").toBe(true);
    for (const [name, principalId] of f.foreign) expect(catalog.dialogueAudience!(owner, principalId), `DIALOGUE_AUDIENCE_EXCLUDES: ${name}`).toBe(false);
  } finally { await catalog.settled!(); await f.close(); }
});

test("the retained-conversation list shows the account's host-only histories and nobody else's", async () => {
  const f = await fixture(); try {
    for (const [id, principalId] of [["argos-voice", f.ship.id], ["ithaca-voice", f.home.id], ["mentor-voice", f.agent.id], ["penelope-voice", f.penelope.id]] as const)
      openDialogue(f.db, { conversationId: id, principalId, epoch: 1, providerId: "fake-live" });
    f.prune("revoked");
    const list = async (principal: Principal) => {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => { c.set("principal", principal); await next(); });
      app.route("/", createSessionRoutes({ db: f.db, registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake", sessions: [] })], "fake") }));
      const page = await (await app.request("/sessions?includeRetainedConversations=true")).json() as { retainedConversations: { id: string }[] };
      return page.retainedConversations.map(r => r.id);
    };
    expect(await list(f.home), "DIALOGUE_LIST_INCLUDES_PRUNED_LOGINS_HISTORY").toEqual(["argos-voice", "ithaca-voice"]);
    expect(await list(f.agent), "DIALOGUE_LIST_AGENT_ONLY_ITS_OWN").toEqual(["mentor-voice"]);
    expect(await list(f.penelope), "DIALOGUE_LIST_AMBIENT_ONLY_ITS_OWN").toEqual(["penelope-voice"]);
    f.db.query("UPDATE dialogue_owners SET principal_account='admiral' WHERE id='ithaca-voice'").run();
    expect(await list(f.home), "DIALOGUE_LIST_DROPS_CORRUPT_EVIDENCE").toEqual(["argos-voice"]);
  } finally { await f.close(); }
});

test("live start: another owner login opens voice on the retained history; a foreign login reaches no provider", async () => {
  const f = await fixture();
  const live = fakeLiveProvider();
  const catalog = createSessionCatalog(() => f.db, undefined, undefined, { writer: f.writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(f.db, f.writer) });
  const host = new WsHost({ registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })], "fake"), catalog, conversationProvider: live.provider });
  const until = async (check: () => boolean) => { const limit = Date.now() + 5000; while (!check()) { if (Date.now() > limit) throw Error("Live start checkpoint unavailable"); await Bun.sleep(1); } };
  const device = async (principal: Principal) => {
    const frames: any[] = [], ws = { send: (data: string) => frames.push(JSON.parse(data)) } as WSContext;
    const handlers = createWsHandlers(host, principal);
    await handlers.onOpen(undefined as never, ws);
    const send = (frame: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(frame.type === "conversation_start" ? { ...frame, disclosed: host.conversations!.profile(false) } : frame) } as MessageEvent, ws);
    send({ type: "client_hello", protocolRev: 5, capabilities: { sessionDialogue: true } });
    return { frames, send, of: (type: string) => frames.filter(x => x.type === type) };
  };
  try {
    const ship = await device(f.ship), home = await device(f.home), mentor = await device(f.agent);
    ship.send({ type: "conversation_start", requestId: "ship-start" });
    await until(() => ship.of("conversation_opened").length === 1);
    const first = ship.of("conversation_opened")[0];
    const firstSeed = JSON.stringify(live.sessions[0]!.options.history);
    live.sessions[0]!.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Set the sail for Ithaca.", timing: { kind: "unavailable" }, finalization: "final" } as never);
    await until(() => home.of("dialogue_history").length === 1);
    expect(ship.of("dialogue_history"), "DIALOGUE_LIVE_PAGE_REACHES_THE_WRITER").toHaveLength(1);
    expect(mentor.of("dialogue_history"), "DIALOGUE_LIVE_PAGE_NEVER_REACHES_ANOTHER_ACCOUNT").toHaveLength(0);
    ship.send({ type: "conversation_stop", conversationId: first.conversationId });
    await until(() => ship.of("conversation_closed").length === 1);
    await host.dialogue.settled();
    // The other device continues the same history in a new conversation of its own.
    home.send({ type: "conversation_start", requestId: "home-start", historyOwnerId: first.historyOwnerId });
    await until(() => home.of("conversation_opened").length === 1);
    const second = home.of("conversation_opened")[0];
    expect([second.historyOwnerId, second.conversationId !== first.conversationId], "DIALOGUE_LIVE_SECOND_LOGIN_CONTINUES").toEqual([first.historyOwnerId, true]);
    expect(live.sessions).toHaveLength(2);
    const seeded = live.sessions[1]!.options.history!.items.flatMap(i => "text" in i ? [i.text] : []);
    expect(seeded, "DIALOGUE_LIVE_SECOND_LOGIN_RECEIVES_RETAINED_HISTORY").toEqual(["Set the sail for Ithaca."]);
    // The second login's own speech lands in the shared history through the journal.
    live.sessions[1]!.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Unbar the hall doors.", timing: { kind: "unavailable" }, finalization: "final" } as never);
    await until(() => ship.of("dialogue_history").length === 2 && home.of("dialogue_history").length === 2);
    await host.dialogue.settled();
    expect(f.db.query("SELECT COUNT(*) AS n FROM dialogue_records").get(), "DIALOGUE_LIVE_SECOND_LOGIN_WRITES_ITS_EPOCH").toEqual({ n: 2 });
    // The first session's provider history is untouched by the continuation.
    expect(JSON.stringify(live.sessions[0]!.options.history), "DIALOGUE_FIRST_SESSION_PREFIX_UNCHANGED").toBe(firstSeed);
    // Another account names the history: refused before any provider effect.
    mentor.send({ type: "conversation_start", requestId: "mentor-start", historyOwnerId: first.historyOwnerId });
    await until(() => mentor.frames.some(x => x.type === "error" || x.type === "conversation_closed"));
    expect(mentor.of("conversation_opened"), "DIALOGUE_LIVE_FOREIGN_NEVER_OPENS").toHaveLength(0);
    expect(live.sessions, "DIALOGUE_LIVE_FOREIGN_HAS_NO_PROVIDER_EFFECT").toHaveLength(2);
    // Ownership metadata never enters the provider-facing history.
    expect(JSON.stringify(live.sessions[1]!.options), "DIALOGUE_NO_OWNERSHIP_METADATA_TO_PROVIDER").not.toMatch(/principal|owner_account|"owner"/);
  } finally { await host.close(); await catalog.settled!(); await f.close(); }
});

for (const third of ["the account's", "an agent's", "an ambient principal's"] as const) test(`a provisional chat both logins typed into, with ${third} turn beside them`, async () => {
  const f = await fixture(); const catalog = catalogOf(f); try {
    // Typed turns before any backend session exists: the history owner is the first turn's binding.
    const first = crypto.randomUUID();
    const turn = async (turnId: string, bindingId: string, principalId: string) => {
      await f.writes.safetyBegin({ turnId, bindingId, sessionId: null, principalId, historyOwnerId: first, backendId: "claude", at: 0 });
      await f.writes.safetyEnd(turnId);
    };
    await turn("voyage", first, f.ship.id);
    await turn("return", crypto.randomUUID(), f.home.id);
    const extra = third === "the account's" ? null : third === "an agent's" ? f.agent.id : f.penelope.id;
    if (extra) await turn("stowaway", crypto.randomUUID(), extra);
    const chat = resolveChat(f.db, { ownerId: first });
    expect("refused" in chat ? chat : chat.owners.length, "PROVISIONAL_RECORDS_EACH_LOGIN").toBe(extra ? 3 : 2);
    const result = await retireProvisional(catalog, f.home.id, "retire-provisional", first);
    if (extra) {
      expect(result, `PROVISIONAL_MIXED_ACCOUNT_REFUSES: ${third}`).toEqual(UNAVAILABLE);
      expect(await retireProvisional(catalog, f.ship.id, "retire-provisional-ship", first)).toEqual(UNAVAILABLE);
      expect(lifecycles(f.db)).toEqual([]);
    } else {
      expect(result, "PROVISIONAL_SHARED_BY_THE_ACCOUNT_RETIRES").toMatchObject({ status: "retired", lifecycleId: first, generation: 2, backendId: null });
      expect(lifecycles(f.db)).toEqual([{ id: first, principal_id: f.home.id, operation_id: "retire-provisional" }]);
    }
  } finally { await catalog.settled!(); await f.close(); }
});

test("the write worker's typed-creation binding keeps its account, so the chat outlives its creator's login", async () => {
  const f = await fixture(); const catalog = catalogOf(f); try {
    // The ship's typed request creates the session; home continues it by voice.
    catalog.persistSessionStub("pylos", "Ask Nestor for news", null, "claude", f.ship.id);
    catalog.persistSessionStub("mentor", "Carry the message", null, "claude", f.agent.id);
    await catalog.dialogueOpen!({ conversationId: "pylos-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "pylos" });
    await catalog.saveConversationEpoch!({ id: "pylos-voice", principalId: f.home.id, epoch: 1, sessionId: "pylos" });
    await catalog.settled!();
    expect(f.db.query("SELECT session_id,principal_id,principal_account FROM chat_session_owners ORDER BY session_id").all(), "CREATION_BINDING_STORES_ITS_ACCOUNT").toEqual([
      { session_id: "mentor", principal_id: f.agent.id, principal_account: null }, { session_id: "pylos", principal_id: f.ship.id, principal_account: "owner" }]);
    f.prune("revoked");
    expect(await retire(catalog, f.home.id, "retire-pylos", "pylos"), "CREATION_BINDING_OUTLIVES_PRUNING").toMatchObject({ status: "retired", lifecycleId: "pylos" });
    // An agent's typed chat is the agent's alone: no owner login deletes it.
    expect(await retire(catalog, f.home.id, "retire-mentor", "mentor"), "AGENT_CREATION_BINDING_STAYS_THE_AGENTS").toEqual(UNAVAILABLE);
  } finally { await catalog.settled!(); await f.close(); }
});

test("upgrading gives legacy epochs and creation bindings an account only where a principal row still proves it", async () => {
  const f = await fixture(); const catalog = catalogOf(f);
  let db = f.db, writer = f.writer;
  try {
    await sharedChat(f, catalog);
    await unrelatedChat(f, catalog);
    f.db.query("INSERT INTO conversation_epochs(id,principal_id,epoch,session_id,updated_at) VALUES('mentor-voice',?,1,'mentor',0)").run(f.agent.id);
    await catalog.settled!();
    // The tables as they stood before 091, with the ship's login pruned before the upgrade.
    f.db.exec(`ALTER TABLE conversation_epochs DROP COLUMN principal_account; ALTER TABLE chat_session_owners DROP COLUMN principal_account;
      DELETE FROM _migrations WHERE filename='091_chat_ownership_account.sql'`);
    f.prune("revoked");
    await f.writer.close(); f.db.close();
    db = createUiDb(join(f.root, "ui.db")); writer = openSqliteWriter(db);
    expect(db.query("SELECT id,principal_id,principal_account FROM conversation_epochs ORDER BY id").all(), "UPGRADE_EPOCH_ACCOUNTS").toEqual([
      { id: "argos-voice", principal_id: f.ship.id, principal_account: null },
      { id: "ithaca-voice", principal_id: f.home.id, principal_account: "owner" },
      { id: "mentor-voice", principal_id: f.agent.id, principal_account: null },
      { id: "pylos-voice", principal_id: f.home.id, principal_account: "owner" },
    ]);
    expect(db.query("SELECT session_id,principal_id,principal_account FROM chat_session_owners ORDER BY session_id").all(), "UPGRADE_CREATION_ACCOUNTS").toEqual([
      { session_id: "ithaca", principal_id: f.ship.id, principal_account: null },
      { session_id: "pylos", principal_id: f.home.id, principal_account: "owner" },
    ]);
    // The lost proof stays unknown: the shared chat refuses, the home login's own chat does not.
    const upgraded = createSessionCatalog(() => db, undefined, undefined, { writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(db, writer) });
    try {
      expect(await retire(upgraded, f.home.id, "retire-ithaca"), "UPGRADE_UNPROVEN_LEGACY_REFUSES").toEqual(UNAVAILABLE);
      expect(await retire(upgraded, f.home.id, "retire-pylos", "pylos"), "UPGRADE_PROVEN_LEGACY_DELETES").toMatchObject({ status: "retired", lifecycleId: "pylos" });
    } finally { await upgraded.settled!(); }
  } finally { await writer.close(); db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

/**
 * A typed turn's unbound safety collection under a chat's history owner is an
 * ownership record whichever branch resolves the chat (#4138 review): a
 * provisional dialogue owner, or a backend session's history owner.
 */
for (const shape of ["provisional dialogue owner", "session history owner"] as const)
  for (const evidence of ["the account's", "corrupt", "another account's"] as const) test(`an unbound safety collection under a ${shape} is one more record: ${evidence}`, async () => {
    const f = await fixture(); const catalog = catalogOf(f); try {
      let historyOwnerId: string;
      if (shape === "provisional dialogue owner") {
        historyOwnerId = (await catalog.dialogueOpen!({ conversationId: "ogygia-voice", principalId: f.ship.id, epoch: 1, providerId: "fake-live" })).id;
        await catalog.dialogueClose!("ogygia-voice", f.ship.id, 1, false);
      } else {
        await sharedChat(f, catalog);
        historyOwnerId = (f.db.query("SELECT id FROM dialogue_owners WHERE session_id='ithaca'").get() as { id: string }).id;
      }
      // The home login types into that history before any session binds the turn.
      const bindingId = crypto.randomUUID();
      await f.writes.safetyBegin({ turnId: "calypso", bindingId, sessionId: null, principalId: f.home.id, historyOwnerId, backendId: "claude", at: 0 });
      await f.writes.safetyEnd("calypso");
      await catalog.settled!();
      expect(f.db.query("SELECT principal_id,principal_account,session_id FROM safety_collections WHERE id=?").get(bindingId)).toEqual({ principal_id: f.home.id, principal_account: "owner", session_id: null });
      if (evidence === "corrupt") f.db.query("UPDATE safety_collections SET principal_account='admiral' WHERE id=?").run(bindingId);
      if (evidence === "another account's") f.db.query("UPDATE safety_collections SET principal_id=?,principal_account=NULL WHERE id=?").run(f.agent.id, bindingId);
      const result = shape === "provisional dialogue owner"
        ? await retireProvisional(catalog, f.home.id, "retire-calypso", historyOwnerId)
        : await retire(catalog, f.home.id, "retire-calypso");
      if (evidence === "the account's") expect(result, `UNBOUND_COLLECTION_OF_THE_ACCOUNT_RETIRES: ${shape}`).toMatchObject({ status: "retired", generation: 2 });
      else {
        expect(result, `UNBOUND_COLLECTION_EVIDENCE_REFUSES: ${shape} ${evidence}`).toEqual(UNAVAILABLE);
        expect(lifecycles(f.db)).toEqual([]);
      }
    } finally { await catalog.settled!(); await f.close(); }
  });
