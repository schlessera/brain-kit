/**
 * The ordinary turn path names a turn's recipient from its backend's relay
 * origin, hands the admitted recipient to the backend, binds what a new
 * conversation was shown to it once it is named, and refuses a later turn or
 * a handoff destination whose recipient may not see it (#2695).
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
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals";

test("a turn's recipient comes from its backend's relay origin and a conversation keeps what it was shown", async () => {
  const storage = spyOn(startup, "isManagedWorkerStartupView").mockReturnValue(true);
  const root = mkdtempSync(join(tmpdir(), "odysseus-recipient-session-")), brain = join(root, "brain");
  mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(brain, "me"));
  writeFileSync(join(brain, "me/identity.md"), "# Odysseus\n");
  writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\nOnly Anthropic reads Odysseus's folder.\n");
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "governed",
    maskPaths: [], index: async () => {}, report() {}, exposures: createProviderExposures(db) });
  let origin = "https://api.anthropic.com";
  const asked: Array<{ profileId?: string; sessionId?: string }> = [];
  const started: Array<Pick<StartTurnRequest, "sessionId"> & { recipient?: unknown; masks?: unknown }> = [];
  const based: string[] = [];
  let named = 0;
  const backend = { ...makeFakeBackend({ id: "claude", startTurn: async request => {
    started.push({ sessionId: request.sessionId, recipient: request.workerSandbox?.inferenceRecipient, masks: request.workerSandbox?.providerMasks });
    // The host bridge tool reads the real brain; its refusals follow the turn's masked set (#2690).
    based.push(await request.bridge.readBrainBase!("me/identity.md").then(base => base.content, error => `refused: ${String(error)}`));
    const sessionId = request.sessionId ?? `voyage-${++named}`;
    request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    request.bridge.emit({ type: "result", sessionId, durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: () => ({ autoAllowed: [], available: [], lock: createKeyedLock() }),
    async inferenceOrigin(req: { profileId?: string; sessionId?: string }) { asked.push(req); return origin; } };
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); } });
  const frames: ServerMessage[] = [];
  host.clients.add({ send: data => frames.push(JSON.parse(data)) }, principal.id);
  const errors = () => frames.flatMap(frame => frame.type === "error" ? [frame.message] : frame.type === "result" && frame.failure ? [frame.failure.message] : []);
  try {
    await runSession(host, { authorization: testAuthorization(principal.id), text: "Odysseus reads his own notes.", attachments: [] });
    expect(started[0], "BACKEND_RECEIVES_THE_ADMITTED_RECIPIENT").toEqual({ sessionId: undefined,
      recipient: { name: "anthropic", origin: "https://api.anthropic.com" }, masks: { folders: [] } });
    expect(based[0], "ALLOWED_ROUTE_READS_THROUGH_BRAIN_READ_BASE").toBe("# Odysseus\n");
    expect(await turns.exposures(["voyage-1"]), "NEW_CONVERSATION_BOUND_WHEN_NAMED").toEqual([{ recipient: "anthropic", visible: ["me"], hidden: [] }]);

    await runSession(host, { authorization: testAuthorization(principal.id), text: "And again.", attachments: [], sessionId: "voyage-1" });
    expect(asked.at(-1), "RESUMED_TURN_ASKS_FOR_ITS_SESSION_ORIGIN").toMatchObject({ sessionId: "voyage-1" });
    expect(started).toHaveLength(2);

    // The profile's route moved to an unlisted gateway: the history would follow it.
    origin = "https://gateway.ithaca.invalid";
    await runSession(host, { authorization: testAuthorization(principal.id), text: "Continue elsewhere.", attachments: [], sessionId: "voyage-1" });
    expect(started, "REFUSED_TURN_NEVER_REACHES_THE_BACKEND").toHaveLength(2);
    expect(errors().join("\n"), "LATER_TURN_REFUSED_BY_NAME").toContain("earlier turns of this conversation showed `me/` to anthropic");

    // A handoff's destination continues its source's history.
    const before = errors().length;
    await runSession(host, { authorization: testAuthorization(principal.id), text: "Summary of the voyage.", attachments: [], source: "handoff",
      handoffHooks: { sourceSessionId: "voyage-1", onNamed() {}, onSettled() {} } });
    expect(started, "HANDOFF_DESTINATION_REFUSED").toHaveLength(2);
    expect(errors().slice(before).join("\n"), "HANDOFF_DESTINATION_REFUSED_BY_NAME").toContain("earlier turns of this conversation showed `me/` to anthropic");

    // A new conversation has no history: it runs, masked.
    await runSession(host, { authorization: testAuthorization(principal.id), text: "A fresh voyage.", attachments: [] });
    expect(started.at(-1)?.recipient, "UNKNOWN_RECIPIENT_HAS_NONE").toBeUndefined();
    expect(started.at(-1)?.masks, "UNKNOWN_RECIPIENT_MASKED").toMatchObject({ folders: ["me"] });
  } finally { storage.mockRestore(); host.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
