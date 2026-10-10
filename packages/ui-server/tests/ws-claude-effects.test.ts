import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityStream } from "../src/activity/stream.js";
import { createUiDb } from "../src/db/client.js";
import { WsHost } from "../src/ws/host.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { makeBridge } from "../src/ws/bridge.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import type { RunningTurn } from "../src/ws/turns.js";

function fixture(voice = false, backendId = "claude") {
  const root = mkdtempSync(join(tmpdir(), "claude-parent-effects-")); const db = createUiDb(":memory:");
  let authorized = true, sends = 0;
  const store = createActivityStore(db, { writer: "claude-parent-test" });
  const stream = createActivityStream(store);
  const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([makeFakeBackend({ id: backendId })], backendId),
    catalog: createSessionCatalog(() => db), activity: { store, stream, query: () => { sends++; return {}; } }, isPrincipalAuthorized: () => authorized, scratchPrune: async () => { sends++; } });
  host.clients.add({ send: text => {
    sends++;
    const frame = JSON.parse(text);
    for (const pending of [host.coordinator.pendingAskUserList, host.coordinator.pendingAskUserRank, host.coordinator.pendingAskUserForm])
      pending.get(frame.requestId)?.resolve({ status: "closed", reason: "cancelled" } as never);
  } }, "odysseus");
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  const turn = { turnId: "raft-turn", principalId: "odysseus", authorization, startedAt: 1, abortController: new AbortController(),
    ...(voice ? { work: { posture: "voice" } } : {}) } as RunningTurn;
  const bridge = makeBridge(host, turn, "Odysseus", backendId, undefined, undefined, undefined, undefined,
    { lock: createKeyedLock(), available: ["write"], autoAllowed: ["write"] });
  return { bridge, turn, revoke: () => { authorized = false; }, sent: () => sends,
    cleanup() { authorization.release(); host.close(); stream.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
test.each(["requestPermission", "askUser", "askUserList", "askUserRank", "askUserForm", "getLocation", "queryActivity", "requestMask"] as const)("parent %s rechecks server authority even when the worker skipped permission hooks", async name => {
  const f = fixture();
  try {
    f.revoke();
    const args = name === "requestPermission" ? [{ toolUseId: "raft", toolName: "Write", input: {} }] : name === "requestMask" ? ["assets/raft.png"] : ["raft", []];
    await expect((f.bridge[name] as (...args: unknown[]) => Promise<unknown>)(...args)).rejects.toThrow("current principal authority");
    expect(f.sent(), "refused parent effect never sends or prunes").toBe(0);
  } finally { f.cleanup(); }
});
test("voice parent executors refuse visual cards and masks without widening membership", async () => {
  const f = fixture(true);
  try {
    for (const name of ["askUserList", "askUserRank", "askUserForm", "requestMask"] as const)
      await expect((f.bridge[name] as (...args: unknown[]) => Promise<unknown>)("raft", [])).rejects.toThrow("outside the voice membership");
    expect(await f.bridge.requestPermission({ toolUseId: "raft", toolName: "Write", input: {} })).toEqual({ behavior: "deny", message: "Voice cannot grant tools." });
    expect(f.sent()).toBe(0); expect(f.bridge.pruneScratch).toBeUndefined();
  } finally { f.cleanup(); }
});
test("a mask application needs the exact browser submission from this live turn", async () => {
  const f = fixture();
  try {
    expect((await f.bridge.applyImageMask!({ imagePath: "assets/raft.png", maskPath: "assets/raft-mask.png", png: Buffer.from([137,80,78,71,13,10,26,10]) })).code).toBe("permission_denied");
    expect(f.sent()).toBe(0);
  } finally { f.cleanup(); }
});

// Pi shares these parent handlers, even when a forged worker skips tool hooks.
test.each(["askUserList", "askUserRank", "askUserForm", "getLocation", "queryActivity", "requestMask"] as const)("pi parent %s independently rechecks current principal authority", async name => {
  const f = fixture(false, "pi");
  try {
    f.revoke();
    await expect((f.bridge[name] as (...args: unknown[]) => Promise<unknown>)("assets/raft.png", [])).rejects.toThrow("current principal authority");
    expect(f.sent(), "revoked pi parent effect never sends or prunes").toBe(0);
  } finally { f.cleanup(); }
});
test("pi PNG application requires a matching browser submission", async () => {
  const f = fixture(false, "pi");
  try {
    expect(f.bridge.applyImageMask, "the host installs Pi's shared PNG route").toBeDefined();
    expect((await f.bridge.applyImageMask!({ imagePath: "assets/raft.png", maskPath: "assets/raft.mask.png", png: Buffer.from([137,80,78,71,13,10,26,10]) })).code).toBe("permission_denied");
    expect(f.sent()).toBe(0);
  } finally { f.cleanup(); }
});
