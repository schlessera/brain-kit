/** Pending cards follow their canonical safety scope; real FULL writers and replies. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { occurrence } from "../src/governance/occurrence";
import { queryGovernanceEvents } from "../src/governance/events";
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
import { openDialogue, bindDialogue } from "../src/ws/dialogue-storage";
import { createEffectiveSafety } from "../src/governance/effective-safety";
import { safetyAdmissionRefusal, STALE_SAFETY_ADMISSION } from "@schlessera/brain-ui-sdk/internal";

for (const mode of ["backward cursor", "exhausted admission"] as const) test(`admission revisions fail closed: ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-scope-revision-")), db = createUiDb(join(root, "ui.db"));
  const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  let loss: Promise<void> | undefined;
  try {
    db.exec("UPDATE safety_meta SET revision='18446744073709551615'");
    const safety = createEffectiveSafety(db, { turnId: "voyage", sessionId: () => null, policyHash: null, writes,
      authority: () => ({ current: true, epoch: "0" }) });
    expect(safety.read().evidenceRevision).toBe("18446744073709551615");
    if (mode === "backward cursor") db.exec("UPDATE safety_meta SET revision='0'");
    else loss = writes.safetyFail("voyage");
    expect(() => safety.read()).toThrow(mode === "backward cursor" ? "moved backwards" : "revision exhausted");
    expect(safetyAdmissionRefusal(safety), "INVALID_REVISION_NEVER_AUTHORIZES_DISPATCH").toBe(STALE_SAFETY_ADMISSION);
  } finally { await loss; await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["other collection", "other occurrence", "own occurrence", "own exposure", "external exposure", "other chat loss", "own loss", "adoption", "adopted pending"] as const) {
  test(`pending approval follows its canonical safety scope: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-approval-scope-")), path = join(root, "ui.db"), db = createUiDb(path);
    const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer), store = createActivityStore(db);
    const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
    const backend = makeFakeBackend({ id: "scripted-scope" });
    const catalog = createSessionCatalog(() => db, undefined, undefined, { writer, store, governance: writes,
      pricing: createModelPricing(resolveStandalonePricingConfig()) });
    const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], backend.id), catalog,
      isPrincipalAuthorized: id => id === principal.id,
      activity: { store, stream: createActivityStream(store), governanceDb: db, governanceWrites: writes } });
    const authorization = host.coordinator.openAuthorization({ principalId: principal.id, valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
    const controller = new AbortController();
    const turn = { sessionId: null, turnId: "voyage", principalId: principal.id, authorization, startedAt: 1,
      abortController: controller, queue: [] } as unknown as RunningTurn;
    const frames: ServerMessage[] = [], raised = Promise.withResolvers<void>();
    const ws = { send(text: string) { const frame = JSON.parse(text) as ServerMessage; frames.push(frame);
      if (frame.type === "tool_approval_request") raised.resolve(); } };
    host.clients.add(ws, principal.id);
    let decision: Promise<PermissionDecision> | undefined, externalDb: Database | undefined;
    let externalWriter: ReturnType<typeof openSqliteWriter> | undefined;
    const release = new Int32Array(new SharedArrayBuffer(4));
    let held: Promise<unknown> | undefined, pending: Promise<unknown> | undefined;
    const add = (target: "voyage" | "other", sessionId: string | null = target === "voyage" ? "ithaca" : "pylos") => writes.firstTaint({ turnId: target, sessionId,
      actor: "interactive", model: null, profile: "governed", kind: "taint", payload: { source: "web_fetch", tool: "WebFetch", detail: null,
        occurrence: occurrence(`binding-${target}`, "tool_web_input", `notice-${target}`, "open") } });
    const other = async () => {
      await writes.safetyBegin({ turnId: "other", bindingId: "binding-other", sessionId: null,
        principalId: principal.id, backendId: backend.id, at: 0 });
      const otherTurn = { ...turn, sessionId: null, turnId: "other", queue: [] } as RunningTurn;
      const bridge = await makeBridge(host, otherTurn, { promptText: "Nestor reads the harbour.", backendId: backend.id });
      bridge.emit({ type: "session_info", sessionId: "pylos", isNew: true });
      await catalog.settled!();
      expect(writes.safety("voyage", "ithaca").session?.historyOwnerId).toBe("binding-voyage");
    };
    try {
      const level = writer.channel(heldWriter, {}); await level.ready;
      expect(writer.offloop).toBe(true); expect(await level.call<number>("level")).toBe(2);
      await writes.safetyBegin({ turnId: "voyage", bindingId: "binding-voyage", sessionId: null,
        principalId: principal.id, backendId: backend.id, at: 0 });
      const bridge = await makeBridge(host, turn, { promptText: "Odysseus repairs the raft.", backendId: backend.id });
      bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
      await catalog.settled!();
      expect(writes.safety("voyage", "ithaca").session?.historyOwnerId, "REAL_CREATED_SESSION_KEEPS_ITS_SAFETY_OWNER").toBe("binding-voyage");
      if (mode === "other occurrence" || mode === "other chat loss") await other();
      if (mode === "own exposure" || mode === "external exposure") await add("voyage");
      if (mode === "adoption" || mode === "adopted pending") {
        openDialogue(db, { conversationId: "target-voice", principalId: principal.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
        const scout = openDialogue(db, { conversationId: "scout-voice", principalId: principal.id, epoch: 1, providerId: "voice" });
        await writes.safetyBegin({ turnId: "other", bindingId: "binding-other", sessionId: null,
          principalId: principal.id, historyOwnerId: scout.id, backendId: backend.id, at: 0 });
        if (mode === "adoption") await add("other", null);
        else bindDialogue(db, "scout-voice", principal.id, "ithaca");
      }
      decision = bridge.requestPermission({ toolUseId: "raft-write", toolName: "Write", kind: "command",
        input: { file_path: "raft.md", content: "Odysseus repairs the raft." } });
      const timeout = setTimeout(() => raised.reject(new Error("Approval did not appear")), 2000);
      try { await raised.promise; } finally { clearTimeout(timeout); }
      const before = bridge.admissionSafety!.read(), aggregate = writes.safety("voyage", "ithaca");
      expect(host.coordinator.pendingApprovals.has("raft-write")).toBe(true);
      if (mode === "other collection") await other();
      else if (mode === "other occurrence") await add("other");
      else if (mode === "own occurrence") await add("voyage");
      else if (mode === "other chat loss" || mode === "own loss") {
        // A loss restricts its own chat only (#3812): another chat's keeps this approval.
        await writes.safetyFail(mode === "own loss" ? "voyage" : "other"); expect(controller.signal.aborted).toBe(false);
      } else if (mode === "adoption") {
        bindDialogue(db, "scout-voice", principal.id, "ithaca");
        expect(writes.safety("voyage", "ithaca").evidenceRevision).toBe(aggregate.evidenceRevision);
        expect(writes.safety("voyage", "ithaca").unresolvedCount, "ADOPTED_EVIDENCE_JOINS_THE_REQUESTING_SESSION").toBe(1);
        expect(BigInt(bridge.admissionSafety!.read().evidenceRevision), "SAME_CURSOR_MEMBERSHIP_ADVANCES_ADMISSION").toBeGreaterThan(BigInt(before.evidenceRevision));
      } else if (mode === "adopted pending") {
        const entered = new Int32Array(new SharedArrayBuffer(4)); held = level.call("hold", entered, release);
        const waiting = Atomics.waitAsync(entered, 0, 0, 5000); if (waiting.async) await waiting.value;
        expect(Atomics.load(entered, 0)).toBe(1);
        pending = add("other", null);
        expect(writes.safety("voyage", "ithaca").evidenceRevision).toBe(aggregate.evidenceRevision);
        expect(host.coordinator.pendingApprovals.has("raft-write"), "ADOPTED_PENDING_INPUT_WITHDRAWS_BEFORE_COMMIT").toBe(false);
        expect(writes.recordingAvailable("voyage", "ithaca"), "ADOPTED_PENDING_INPUT_STOPS_PROVIDER_DELIVERY").toBe(false);
        expect(writes.taint("voyage", "ithaca"), "ADOPTED_PENDING_INPUT_IS_EFFECTIVE_TAINT").toEqual({ eventId: 0, source: "web_fetch" });
        expect(writes.safety("other", null).pendingCount, "PROVISIONAL_TURN_RESOLVES_CANONICAL_MEMBERSHIP").toBe(1);
        Atomics.store(release, 0, 1); Atomics.notify(release, 0); await held; await pending;
      } else {
        const occurrenceId = (db.query("SELECT id FROM safety_records WHERE kind='occurrence'").get() as { id: string }).id;
        const event = { turnId: "voyage", sessionId: "ithaca", actor: "interactive" as const, model: null, profile: "governed" as const,
          kind: "taint_exposure" as const, payload: { occurrenceId, state: "finalized" as const } };
        if (mode === "external exposure") {
          externalDb = new Database(path); externalWriter = openSqliteWriter(externalDb);
          await createGovernanceWrites(externalDb, externalWriter).record(event);
          // This process receives no local invalidation hint from the second writer.
          expect(host.coordinator.pendingApprovals.has("raft-write")).toBe(true);
          const after = writes.safety("voyage", "ithaca");
          expect([after.unresolvedCount, after.earliestUnresolvedId, after.coverage]).toEqual(
            [aggregate.unresolvedCount, aggregate.earliestUnresolvedId, aggregate.coverage]);
        } else await writes.record(event);
      }
      await writer.idle();
      const unrelated = mode === "other collection" || mode === "other occurrence" || mode === "other chat loss";
      if (unrelated) {
        expect(writes.safety("voyage", "ithaca").evidenceRevision).not.toBe(aggregate.evidenceRevision);
        expect(bridge.admissionSafety!.read(), "UNRELATED_SCOPE_MUST_KEEP_ADMISSION_SNAPSHOT").toEqual(before);
        expect(host.coordinator.pendingApprovals.has("raft-write"), "UNRELATED_SESSION_MUST_NOT_WITHDRAW_PENDING_APPROVAL").toBe(true);
      }
      await handleToolApproval({ host, ws, requireEcho: true, connection: { principal, authorization } } as never,
        { type: "tool_approval", toolUseId: "raft-write", turnId: "voyage", channel: "card" });
      const result = await decision;
      if (result.behavior === "allow") writeFileSync(join(root, "raft.md"), "Odysseus repairs the raft.");
      expect(result.behavior, "ONLY_UNRELATED_EVIDENCE_PRESERVES_APPROVAL").toBe(unrelated ? "allow" : "deny");
      expect(existsSync(join(root, "raft.md")), "SCOPED_APPROVAL_HAS_THE_EXPECTED_FILE_EFFECT").toBe(unrelated);
      expect(queryGovernanceEvents(db, { kinds: ["safety_admission_expired"], limit: 10 }),
        "RELATED_CHANGE_WITHDRAWS_EXACTLY_ONCE").toHaveLength(unrelated ? 0 : 1);
    } finally {
      Atomics.store(release, 0, 1); Atomics.notify(release, 0);
      controller.abort(); await host.close(); await Promise.allSettled([decision]); authorization.release();
      await Promise.allSettled([held, pending]);
      await externalWriter?.close(); externalDb?.close(); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true });
    }
  });
}
