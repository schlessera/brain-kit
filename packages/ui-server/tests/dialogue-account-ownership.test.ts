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
import { resolveChat } from "../src/ws/chat-lifecycle";
import { createSessionCatalog } from "../src/ws/session-catalog";
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
    db.query("INSERT INTO chat_session_owners VALUES('ithaca',?,0)").run(principalId);
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
    // Deletion keeps its exact-principal rule: the second login is refused as before.
    openDialogue(f.db, { conversationId: "ithaca-voice", principalId: f.home.id, epoch: 1, providerId: "fake-live", sessionId: "ithaca" });
    f.db.query("INSERT INTO conversation_epochs(id,principal_id,epoch,session_id,updated_at) VALUES('argos-voice',?,1,'ithaca',0),('ithaca-voice',?,1,'ithaca',0)").run(f.ship.id, f.home.id);
    expect(resolveChat(f.db, { sessionId: "ithaca" }), "DIALOGUE_DELETION_STAYS_EXACT").toEqual({ refused: "unavailable" });
  } finally { await f.close(); }
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
