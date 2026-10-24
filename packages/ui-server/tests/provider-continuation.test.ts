/**
 * A provider-denied hosted turn continues a conversation only when the host's
 * lineage proves every folder it masks was masked from every earlier turn
 * (#2726). Production admission and the durable exposure record, through the
 * ordinary turn path: born-masked conversations continue, an unmasked or
 * allowed-route turn narrows the lineage, and pre-policy, legacy, widened and
 * unqualified handoff continuations refuse before history reaches a backend.
 */
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { expect, spyOn, test } from "bun:test";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createKeyedLock, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { createProviderExposures } from "../src/brain/provider-exposure";
import { maskedInBoth, uncoveredFolders } from "../src/brain/governance-policy";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { writePolicy } from "./helpers/provider-policy";
import { testAuthorization } from "./helpers/principal";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals";
import { createInboxIntake } from "../src/inbox/intake";
import { createInboxBridgeTools } from "../src/inbox/bridge-tools";
import { createInboxResolver } from "../src/inbox/resolve";
import { admitOriginThread } from "../src/inbox/provenance";
import { governancePolicyReaderFor } from "../src/brain/governance-policy";

function world() {
  const storage = spyOn(startup, "isManagedWorkerStartupView").mockReturnValue(true);
  const root = mkdtempSync(join(tmpdir(), "odysseus-continuation-")), brain = join(root, "brain");
  for (const dir of ["context/policies", "me", "health"]) mkdirSync(join(brain, dir), { recursive: true });
  writeFileSync(join(brain, "me/identity.md"), "# Odysseus\nThe Cyclops knows him as Nobody.\n");
  writeFileSync(join(brain, "health/scar.md"), "# The boar's scar\n");
  writePolicy(brain, ["me"]);
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const exposures = createProviderExposures(db);
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "governed",
    maskPaths: [], index: async () => {}, report() {}, exposures, privateIndexCommand: ["/bin/true"] });
  // An unlisted gateway proves no recipient, so every provider folder is denied.
  const route = { origin: "https://gateway.ithaca.invalid" };
  const started: Array<{ sessionId?: string; masks?: readonly string[] }> = [];
  // Text the next turn adds through its own `inbox_add` before the session is named, and what it got back.
  const adds: Array<{ text: string; before?: () => void }> = [], added: Array<{ threadId: string; itemId: string }> = [];
  let named = 0;
  const backend = { ...makeFakeBackend({ id: "claude", startTurn: async (request: StartTurnRequest) => {
    started.push({ sessionId: request.sessionId, ...(request.workerSandbox?.providerMasks ? { masks: request.workerSandbox.providerMasks.folders } : {}) });
    const add = adds.shift();
    if (add) { add.before?.(); added.push(await request.bridge.inboxAdd!({ text: add.text, idempotencyKey: crypto.randomUUID() })); }
    const sessionId = request.sessionId ?? `voyage-${++named}`;
    request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    request.bridge.emit({ type: "result", sessionId, durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: () => ({ autoAllowed: [], available: [], lock: createKeyedLock() }),
    async inferenceOrigin() { return route.origin; } };
  const intake = createInboxIntake(db, brain);
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => db),
    inboxTools: createInboxBridgeTools(db, intake, createInboxResolver(db, { allowedOperations: () => [] })),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); } });
  const frames: ServerMessage[] = [];
  host.clients.add({ send: data => frames.push(JSON.parse(data)) }, principal.id);
  const errors = () => frames.flatMap(frame => frame.type === "error" ? [frame.message] : []);
  const send = async (text: string, extra: { sessionId?: string; handoff?: string } = {}) => {
    const before = errors().length, count = started.length;
    await runSession(host, { authorization: testAuthorization(principal.id), text, attachments: [],
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
      ...(extra.handoff ? { source: "handoff" as const, handoffHooks: { sourceSessionId: extra.handoff, onNamed() {}, onSettled() {} } } : {}) });
    return { admitted: started.length > count, turn: started.at(-1), refusal: errors().slice(before).join("\n") };
  };
  /** Whether a masked autonomous turn may start on this thread: production admission (#2741). */
  const qualifies = async (threadId: string, masked: string[]) => {
    try {
      await admitOriginThread(db, brain, { runId: crypto.randomUUID(), threadId, masked, policyHash: governancePolicyReaderFor(brain).load().hash });
      return "admitted";
    } catch (error) { return (error as Error).message; }
  };
  return { brain, db, exposures, turns, route, started, adds, added, send, qualifies,
    async close() { storage.mockRestore(); host.close(); await intake.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the always-masked set narrows by containment and covers nested masks", () => {
  expect(maskedInBoth(["me"], ["me/private", "health"])).toEqual(["me/private"]);
  expect(maskedInBoth(["me/private"], ["me"])).toEqual(["me/private"]);
  expect(maskedInBoth(["me", "health"], [])).toEqual([]);
  expect(uncoveredFolders(["me/private"], ["me"]), "NESTED_MASK_COVERED").toEqual([]);
  expect(uncoveredFolders(["me"], ["me/private"]), "OUTER_MASK_NOT_COVERED_BY_INNER").toEqual(["me"]);
});

test("a conversation born masked continues, and an unmasked turn narrows its lineage so a later denial refuses", async () => {
  const w = world();
  try {
    const first = await w.send("Odysseus plans the voyage.");
    expect(first.turn, "FRESH_DENIED_TURN_ADMITTED").toEqual({ sessionId: undefined, masks: ["me"] });
    expect(w.exposures.maskedThroughout("voyage-1"), "BORN_MASKED_LINEAGE_RECORDED").toEqual(["me"]);

    const second = await w.send("And the next leg.", { sessionId: "voyage-1" });
    expect(second.turn, "BORN_MASKED_CONTINUATION_ADMITTED").toEqual({ sessionId: "voyage-1", masks: ["me"] });

    // The policy briefly has no provider rules: that turn could read `me/`.
    writePolicy(w.brain, null);
    const open = await w.send("Read everything.", { sessionId: "voyage-1" });
    expect(open.turn, "UNMASKED_TURN_RUNS").toEqual({ sessionId: "voyage-1" });
    expect(w.exposures.maskedThroughout("voyage-1"), "LINEAGE_NARROWED_BY_UNMASKED_TURN").toEqual([]);
    // Narrowed in place: no older, wider row survives for a lost one to expose.
    expect(w.db.query("SELECT masked FROM session_masked_lineage WHERE session_id = ?").all("voyage-1"), "ONE_LINEAGE_ROW_PER_SESSION").toEqual([{ masked: "[]" }]);

    writePolicy(w.brain, ["me"]);
    const after = await w.send("Back under the rule.", { sessionId: "voyage-1" });
    expect(after.admitted, "DENIAL_AFTER_VISIBLE_TURN_REFUSED").toBe(false);
    expect(after.refusal).toContain("an earlier turn could see it");
    expect(after.refusal).toContain("Start a new conversation");
  } finally { await w.close(); }
});

test("an allowed-route turn narrows the lineage too", async () => {
  const w = world();
  try {
    await w.send("Odysseus plans the voyage.");
    w.route.origin = "https://api.anthropic.com";
    const allowed = await w.send("Anthropic may read `me/`.", { sessionId: "voyage-1" });
    expect(allowed.turn, "ALLOWED_ROUTE_CONTINUES").toEqual({ sessionId: "voyage-1", masks: [] });
    expect(w.exposures.maskedThroughout("voyage-1"), "ALLOWED_ROUTE_NARROWS_LINEAGE").toEqual([]);
    w.route.origin = "https://gateway.ithaca.invalid";
    const denied = await w.send("Through the gateway again.", { sessionId: "voyage-1" });
    expect(denied.admitted, "DENIAL_AFTER_ALLOWED_ROUTE_REFUSED").toBe(false);
  } finally { await w.close(); }
});

test("pre-policy, legacy and record-less conversations refuse under the same policy and are never stamped clean", async () => {
  const w = world();
  try {
    writePolicy(w.brain, null);
    await w.send("Before any provider rule, Odysseus reads `me/identity.md`.");
    writePolicy(w.brain, ["me"]);
    const prePolicy = await w.send("Continue under the rule.", { sessionId: "voyage-1" });
    expect(prePolicy.admitted, "PRE_POLICY_CONTINUATION_REFUSED").toBe(false);
    expect(prePolicy.refusal).toContain("no record of the conversation starting under these rules");
    expect(prePolicy.refusal).toContain("Start a new conversation; the saved one is kept unchanged");
    expect(w.exposures.maskedThroughout("voyage-1"), "REFUSAL_NEVER_STAMPS_LINEAGE").toBeUndefined();

    // A conversation this server never recorded, under the very same policy.
    const legacy = await w.send("An old conversation.", { sessionId: "legacy-voyage" });
    expect(legacy.admitted, "LEGACY_CONTINUATION_REFUSED").toBe(false);

    // Born masked under the same policy, but its record is gone: unprovable.
    await w.send("A fresh voyage.");
    expect(w.exposures.maskedThroughout("voyage-2")).toEqual(["me"]);
    w.db.query("DELETE FROM session_masked_lineage WHERE session_id = ?").run("voyage-2");
    const lost = await w.send("Continue it.", { sessionId: "voyage-2" });
    expect(lost.admitted, "MISSING_RECORD_REFUSED").toBe(false);
    expect(w.started.filter(turn => turn.sessionId), "NO_REFUSED_CONTINUATION_REACHES_THE_BACKEND").toEqual([]);
  } finally { await w.close(); }
});

test("a widened policy refuses the folders the conversation did not always mask", async () => {
  const w = world();
  try {
    await w.send("Odysseus plans the voyage.");
    writePolicy(w.brain, ["me", "health"]);
    const widened = await w.send("Now health is hidden too.", { sessionId: "voyage-1" });
    expect(widened.admitted, "WIDENED_MASKS_REFUSED").toBe(false);
    expect(widened.refusal).toContain("`health/`");
    expect(widened.refusal).not.toContain("`me/`");
  } finally { await w.close(); }
});

test("a handoff continues only a born-masked source, starting its own lineage from it", async () => {
  const w = world();
  try {
    await w.send("Odysseus plans the voyage.");
    const handoff = await w.send("Summary of the voyage.", { handoff: "voyage-1" });
    expect(handoff.turn, "HANDOFF_FROM_BORN_MASKED_ADMITTED").toEqual({ sessionId: undefined, masks: ["me"] });
    expect(w.exposures.maskedThroughout("voyage-2"), "HANDOFF_DESTINATION_INHERITS_LINEAGE").toEqual(["me"]);

    writePolicy(w.brain, null);
    await w.send("Before the rule.");
    writePolicy(w.brain, ["me"]);
    const unqualified = await w.send("Summary of the old voyage.", { handoff: "voyage-3" });
    expect(unqualified.admitted, "HANDOFF_WITHOUT_LINEAGE_REFUSED").toBe(false);
    expect(unqualified.refusal).toContain("the chat this handoff continues");
  } finally { await w.close(); }
});

test("a run with no proven recipient may carry only history born with every provider folder hidden", async () => {
  const w = world();
  try {
    writePolicy(w.brain, null);
    await w.send("Before the rule.");
    expect(w.turns.unprovenHistory("voyage-1"), "NO_PROVIDER_RULES_NOTHING_HIDDEN").toBe(false);
    writePolicy(w.brain, ["me"]);
    expect(w.turns.unprovenHistory("voyage-1"), "PRE_POLICY_HISTORY_UNPROVEN").toBe(true);
    await w.send("A fresh voyage.");
    expect(w.turns.unprovenHistory("voyage-2"), "BORN_MASKED_HISTORY_PROVEN").toBe(false);
    writePolicy(w.brain, ["me", "health"]);
    expect(w.turns.unprovenHistory("voyage-2"), "WIDENED_POLICY_UNPROVEN").toBe(true);
    // A type's folders follow the current taxonomy, which this check does not translate.
    writeFileSync(join(w.brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }, { types: [note], allow: [anthropic] }]\n---\nNotes stay with Anthropic.\n");
    expect(w.turns.unprovenHistory("voyage-2"), "TYPE_SELECTOR_UNPROVEN").toBe(true);
  } finally { await w.close(); }
});

test("an item a born-masked conversation adds qualifies a masked autonomous turn its masks contain", async () => {
  const w = world();
  try {
    writePolicy(w.brain, ["me", "health"]);
    w.adds.push({ text: "Penelope's loom goes on the list." });
    const first = await w.send("Odysseus plans the voyage.");
    expect(first.turn).toEqual({ sessionId: undefined, masks: ["health", "me"] });
    const [born] = w.added;
    expect(await w.qualifies(born!.threadId, ["me"]), "BORN_MASKED_CONVERSATION_ITEM_ADMITTED").toBe("admitted");
    expect(await w.qualifies(born!.threadId, ["me/letters"]), "NESTED_MASK_ADMITTED").toBe("admitted");
    expect(await w.qualifies(born!.threadId, ["health", "me"]), "EVERY_LINEAGE_MASK_ADMITTED").toBe("admitted");
    expect(await w.qualifies(born!.threadId, ["me", "finance"]), "MASK_OUTSIDE_LINEAGE_REFUSED").toContain(`item:${born!.itemId}`);
    const row = w.db.query("SELECT origin, hidden, turn_id, run_id FROM inbox_provenance WHERE subject = ?").get(`item:${born!.itemId}`);
    expect(row, "HOST_LINEAGE_RECORDED_FOR_THE_ADDING_TURN").toEqual({ origin: "conversation", hidden: JSON.stringify(["health", "me"]), turn_id: expect.any(String), run_id: null });

    // A later turn narrows the lineage; what it adds carries the narrowed set.
    writePolicy(w.brain, ["me"]);
    w.adds.push({ text: "Telemachus asks about the ships." });
    const second = await w.send("And the next leg.", { sessionId: "voyage-1" });
    expect(second.turn).toEqual({ sessionId: "voyage-1", masks: ["me"] });
    const narrowed = w.added[1]!;
    expect(await w.qualifies(narrowed.threadId, ["me"]), "CONTINUING_TURN_ITEM_ADMITTED").toBe("admitted");
    expect(await w.qualifies(narrowed.threadId, ["health"]), "NARROWED_LINEAGE_REFUSES_A_DROPPED_MASK").toContain(`item:${narrowed.itemId}`);
  } finally { await w.close(); }
});

test("an item a pre-policy, widened or record-less conversation adds never qualifies", async () => {
  const w = world();
  try {
    // Pre-policy: the conversation's turn could read `me/`, and it has no lineage.
    writePolicy(w.brain, null);
    w.adds.push({ text: "Added before any provider rule." });
    await w.send("Before the rule.");
    writePolicy(w.brain, ["me"]);
    const prePolicy = w.added[0]!;
    expect(await w.qualifies(prePolicy.threadId, ["me"]), "PRE_POLICY_CONVERSATION_ITEM_REFUSED").toContain(`item:${prePolicy.itemId}`);

    // Widened: born masked, then a turn without the rule could read `me/`; its item is refused.
    await w.send("A fresh voyage.");
    writePolicy(w.brain, null);
    w.adds.push({ text: "Added once `me/` was visible." });
    await w.send("Read everything.", { sessionId: "voyage-2" });
    writePolicy(w.brain, ["me"]);
    const widened = w.added[1]!;
    expect(w.exposures.maskedThroughout("voyage-2")).toEqual([]);
    expect(await w.qualifies(widened.threadId, ["me"]), "WIDENED_CONVERSATION_ITEM_REFUSED").toContain(`item:${widened.itemId}`);

    // An allowed route shows the folder to its recipient: the same.
    await w.send("Another voyage.");
    w.route.origin = "https://api.anthropic.com";
    w.adds.push({ text: "Added on the allowed route." });
    await w.send("Anthropic may read `me/`.", { sessionId: "voyage-3" });
    w.route.origin = "https://gateway.ithaca.invalid";
    const allowed = w.added[2]!;
    expect(await w.qualifies(allowed.threadId, ["me"]), "ALLOWED_ROUTE_CONVERSATION_ITEM_REFUSED").toContain(`item:${allowed.itemId}`);

    // Record-less: born masked, but its own lineage is gone when the item is
    // added, while another conversation's qualifying lineage remains.
    await w.send("An unrelated masked voyage.");
    expect(w.exposures.maskedThroughout("voyage-4")).toEqual(["me"]);
    w.adds.push({ text: "Added after the record was lost.", before: () => w.db.query("DELETE FROM session_masked_lineage WHERE session_id IS NULL").run() });
    await w.send("Yet another voyage.");
    const lost = w.added[3]!;
    expect(await w.qualifies(lost.threadId, ["me"]), "RECORD_LESS_CONVERSATION_ITEM_REFUSED").toContain(`item:${lost.itemId}`);
    expect(w.db.query("SELECT subject FROM inbox_provenance WHERE subject IN (?, ?)").all(`item:${prePolicy.itemId}`, `item:${lost.itemId}`),
      "NOTHING_RECORDED_WITHOUT_LINEAGE").toEqual([]);
  } finally { await w.close(); }
});
