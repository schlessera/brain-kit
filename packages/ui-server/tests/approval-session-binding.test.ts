/** A first approval snapshots the durable identity of its own announced session. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createModelPricing } from "../src/pricing/model-pricing";
import { resolveStandalonePricingConfig } from "../src/config/env";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { WsHost } from "../src/ws/host";
import { makeBridge } from "../src/ws/bridge";
import type { RunningTurn } from "../src/ws/turns";
import { handleToolApproval } from "../src/ws/handlers/tool-permission";
import { makeFakeBackend } from "./helpers/fake-backend";
import * as heldWriter from "./fixtures/held-publication-writer";

for (const mode of ["healthy", "recording loss", "revocation", "cancellation"] as const) {
  test(`first approval joins its own FULL-writer binding: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-approval-binding-")), db = createUiDb(join(root, "ui.db"));
    const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer), store = createActivityStore(db);
    const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
    const backend = makeFakeBackend({ id: "scripted-binding" });
    const catalog = createSessionCatalog(() => db, undefined, undefined, {
      writer, store, governance: writes, pricing: createModelPricing(resolveStandalonePricingConfig()),
    });
    const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], backend.id), catalog,
      isPrincipalAuthorized: id => id === principal.id,
      activity: { store, stream: createActivityStream(store), governanceDb: db, governanceWrites: writes } });
    const authorization = host.coordinator.openAuthorization({ principalId: principal.id, valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
    const controller = new AbortController();
    const turn = { turnId: "voyage", principalId: principal.id, authorization, startedAt: 1,
      abortController: controller, queue: [] } as unknown as RunningTurn;
    const frames: ServerMessage[] = [], raised = Promise.withResolvers<void>();
    const ws = { send(text: string) {
      const frame = JSON.parse(text) as ServerMessage; frames.push(frame);
      if (frame.type === "tool_approval_request") raised.resolve();
    } };
    host.clients.add(ws, principal.id);
    const release = new Int32Array(new SharedArrayBuffer(4));
    let held: Promise<unknown> | undefined, loss: Promise<unknown> | undefined, decision: Promise<PermissionDecision> | undefined;
    try {
      await writes.safetyBegin({ turnId: "voyage", bindingId: "binding-voyage", sessionId: null,
        principalId: principal.id, backendId: backend.id, at: 0 });
      const bridge = await makeBridge(host, turn, { promptText: "Return to Ithaca", backendId: backend.id });
      const channel = writer.channel(heldWriter, {}); await channel.ready;
      expect(await channel.call<number>("level")).toBe(2);
      const entered = new Int32Array(new SharedArrayBuffer(4)); held = channel.call("hold", entered, release);
      const waiting = Atomics.waitAsync(entered, 0, 0, 5000); if (waiting.async) await waiting.value;
      expect(Atomics.load(entered, 0)).toBe(1);
      bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
      expect(bridge.admissionSafety!.read().recordingAvailable).toBe(true);
      const before = bridge.admissionSafety!.read();
      decision = bridge.requestPermission({ toolUseId: "raft-write", toolName: "Write", kind: "command",
        input: { file_path: "notes/raft.md", content: "Odysseus repairs the raft." } });
      expect(frames.some(frame => frame.type === "tool_approval_request"), "FIRST_CARD_WAITS_FOR_OWN_BINDING").toBe(false);
      if (mode === "recording loss") {
        loss = writes.safetyFail("another-turn");
        expect(controller.signal.aborted).toBe(false);
      } else if (mode === "revocation") authorization.valid = false;
      else if (mode === "cancellation") controller.abort();
      Atomics.store(release, 0, 1); Atomics.notify(release, 0); await held; await writer.idle();
      if (mode === "healthy") {
        const deadline = setTimeout(() => raised.reject(new Error("Bound approval did not appear")), 2000);
        try { await raised.promise; } finally { clearTimeout(deadline); }
        expect(host.coordinator.pendingApprovals.has("raft-write"), "HEALTHY_FIRST_CARD_SURVIVES_OWN_BINDING").toBe(true);
        const current = bridge.admissionSafety!.read();
        expect(current.scope).not.toBe(before.scope);
        expect(host.coordinator.pendingApprovals.get("raft-write")!.request.admissionSnapshot).toEqual(current);
        await handleToolApproval({ host, ws, requireEcho: true, connection: { principal, authorization } } as never,
          { type: "tool_approval", toolUseId: "raft-write", turnId: "voyage", channel: "card" });
      }
      const result = await decision;
      if (result.behavior === "allow") {
        mkdirSync(join(root, "notes")); writeFileSync(join(root, "notes/raft.md"), "Odysseus repairs the raft.");
      }
      expect(result.behavior).toBe(mode === "healthy" ? "allow" : "deny");
      expect(existsSync(join(root, "notes/raft.md")), "POST_BINDING_LOSS_OR_REVOCATION_RUNS_NOTHING").toBe(mode === "healthy");
      if (mode !== "healthy") expect(frames.some(frame => frame.type === "tool_approval_request")).toBe(false);
      // The scripted backend did not claim detector completeness.
      expect(writes.safety("voyage", "ithaca").restriction).toBe("restricted");
    } finally {
      Atomics.store(release, 0, 1); Atomics.notify(release, 0); controller.abort();
      await host.close(); await Promise.allSettled([held, loss, decision]); authorization.release();
      await writer.close(); db.close(); rmSync(root, { recursive: true, force: true });
    }
  });
}
