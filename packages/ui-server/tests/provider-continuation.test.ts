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
  let named = 0;
  const backend = { ...makeFakeBackend({ id: "claude", startTurn: async (request: StartTurnRequest) => {
    started.push({ sessionId: request.sessionId, ...(request.workerSandbox?.providerMasks ? { masks: request.workerSandbox.providerMasks.folders } : {}) });
    const sessionId = request.sessionId ?? `voyage-${++named}`;
    request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    request.bridge.emit({ type: "result", sessionId, durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: () => ({ autoAllowed: [], available: [], lock: createKeyedLock() }),
    async inferenceOrigin() { return route.origin; } };
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => db),
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
  return { brain, db, exposures, turns, route, started, send,
    close() { storage.mockRestore(); host.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
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
  } finally { w.close(); }
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
  } finally { w.close(); }
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
  } finally { w.close(); }
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
  } finally { w.close(); }
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
  } finally { w.close(); }
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
  } finally { w.close(); }
});
