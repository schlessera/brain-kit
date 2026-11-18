// #2869: the live bridge hands a conversation's `inbox_add` its write
// boundary. A journal observation or a scope pause that begins after the
// bridge's entry wait, at intake's receipt check, holds the intake rather than
// refusing it, keeps the brain lock free, and one item is accepted after it.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { BRAIN_LOCK_KEY, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import type { TurnJournal } from "../src/brain/turn-journal.js";
import type { TurnScope } from "../src/brain/turn-scope.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createInboxBridgeTools } from "../src/inbox/bridge-tools.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { createInboxResolver } from "../src/inbox/resolve.js";
import { WsHost } from "../src/ws/host.js";
import { runSession } from "../src/ws/run-session.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

test.each(["journal", "scope"] as const)("a %s hold that begins at inbox_add's receipt check waits and accepts one item after it (#2869)", async kind => {
  const root = mkdtempSync(join(tmpdir(), "ws-inbox-hold-"));
  const db = createUiDb(":memory:");
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const staging = join(root, SHARE_STAGING_DIR);
  const published = () => existsSync(staging) ? readdirSync(staging).filter(name => !name.startsWith(".")) : [];
  const items = () => (db.query("SELECT COUNT(*) AS n FROM inbox_items").get() as { n: number }).n;
  // The hold begins the first time a check runs once the arrival is
  // published: the receipt check, after the bridge's own entry wait.
  const state = { armed: false, held: false, raised: false };
  const raise = () => { if (state.armed && !state.raised && published().length) { state.raised = true; state.held = true; } };
  let settle: (() => void) | undefined;
  const journal = {
    isHeld: () => { if (kind === "journal") raise(); return kind === "journal" && state.held; },
    idle: async () => { if (kind === "journal" && state.held) await new Promise<void>(resolve => { settle = resolve; }); },
    observe: async () => {}, toolStarted() {}, toolEnded: async () => {}, summary: () => ({ state: "unknown" }), bindSession: async () => {}, finish: async () => {},
  } as unknown as TurnJournal;
  const scope = { isPaused: () => { if (kind === "scope") raise(); return kind === "scope" && state.held; }, toolCall() {}, bindSession() {}, finish() {}, close() {} } as unknown as TurnScope;
  let failure: unknown, proven = false;
  let host!: WsHost;
  const backend = makeFakeBackend({ id: "pi", startTurn: async req => {
    try { await proof(req.bridge); } catch (error) { failure = error; }
  } });
  async function proof(bridge: BackendBridge) {
    state.armed = true;
    let outcome: unknown;
    const pending = bridge.inboxAdd!({ text: "Odysseus lashes the raft before the storm.", idempotencyKey: "raft" })
      .then(value => { outcome = value; return value; }, error => { outcome = error; throw error; });
    for (let turn = 0; turn < 400 && !state.held && outcome === undefined; turn++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(state.raised, "WS_INBOX_HOLD_RAISED_AT_RECEIPT").toBe(true);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(outcome, "WS_INBOX_HOLD_WAITS_RATHER_THAN_REFUSING").toBeUndefined();
    expect(items(), "WS_INBOX_HOLD_NO_RECEIPT_UNDER_HOLD").toBe(0);
    // The wait holds no brain lock: Continue/Stop and the observation can proceed.
    let locked = false;
    await host.workerLock.withLock(BRAIN_LOCK_KEY, async () => { locked = true; });
    expect(locked, "WS_INBOX_HOLD_LEAVES_BRAIN_LOCK_FREE").toBe(true);
    state.held = false; settle?.();
    expect((await pending).created, "WS_INBOX_HOLD_ACCEPTS_AFTER_RELEASE").toBe(true);
    expect(items()).toBe(1);
    expect(published()).toHaveLength(1);
    proven = true;
  }
  const intake = createInboxIntake(db, root);
  host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], "pi"), catalog: createSessionCatalog(() => db),
    inboxTools: createInboxBridgeTools(db, intake, createInboxResolver(db, { allowedOperations: () => [] }), root),
    isPrincipalAuthorized: () => true, journal, scope });
  const authorization = host.coordinator.openAuthorization({ principalId: principal.id, valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  try {
    const running = runSession(host, { authorization, text: "Add the raft to the inbox", attachments: [] });
    authorization.release(); await running;
    if (failure) throw failure;
    expect(proven, "WS_INBOX_HOLD_TURN_RAN").toBe(true);
  } finally { host.close(); await intake.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
