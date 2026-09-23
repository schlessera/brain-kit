/**
 * A turn's runtime report and auth failure reach `/api/status`'s runtime
 * state through the real inbound path (#211): the host relays the backend's
 * activity to the runtime status it was given, keyed by the turn's run.
 */
import { describe, expect, test } from "bun:test";

import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createRuntimeStatus } from "../src/activity/runtime-status";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createUiDb } from "../src/db/client";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("the runtime status over the ws path", () => {
  test("a turn's runtime report and auth failure are kept for /api/status, on that turn's run", async () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "server-test" });
    const stream = createActivityStream(store);
    const runtime = createRuntimeStatus(() => new Date("2026-09-23T12:00:00Z"));
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async ({ bridge }: { bridge: BackendBridge }) => {
        bridge.emit({ type: "session_info", sessionId: "sess-1", isNew: true });
        bridge.activity?.({
          kind: "runtime_observed",
          runtime: { name: "claude-code", version: "2.1.999" },
          sdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.999" },
          billing: "subscription",
          policy: "subscription",
        });
        bridge.activity?.({ kind: "auth_failure", errorClass: "authentication_failed", message: "Refused." });
        bridge.emit({
          type: "result",
          sessionId: "sess-1",
          outcome: "error",
          costUsd: 0,
          durationMs: 1,
          numTurns: 1,
          isError: true,
        });
      },
    });
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      observability: createRecordingObservability(),
      activity: { store, stream, runtime },
    });
    try {
      const sent: string[] = [];
      const ws = { send: (data: string) => sent.push(data), close: () => {}, readyState: 1 } as unknown as WSContext;
      const handlers = createWsHandlers(host, testPrincipal());
      handlers.onOpen(undefined as never, ws);
      handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent, ws);
      await until(() => runtime.snapshot().lastAuthFailure !== undefined);

      const snapshot = runtime.snapshot();
      expect(snapshot.lastObserved).toMatchObject({ runtime: { version: "2.1.999" }, at: "2026-09-23T12:00:00.000Z" });
      expect(snapshot.lastAuthFailure).toMatchObject({
        errorClass: "authentication_failed",
        runId: snapshot.lastObserved!.runId,
        at: "2026-09-23T12:00:00.000Z",
      });
      expect(store.getSpan(`${snapshot.lastAuthFailure!.runId}:turn`)).toBeDefined();
    } finally {
      host.close();
      stream.close();
      db.close();
    }
  });
});
