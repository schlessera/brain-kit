import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { WsHost } from "../src/ws/host.js";
import { runSession } from "../src/ws/run-session.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization } from "./helpers/principal.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

for (const kind of ["cancel", "classified", "budget", "uncorrelated", "timeout", "identity", "other-message", "other-backend"] as const)
test(`hosted native acquisition terminal preserves ${kind}`, async () => {
  const db = createUiDb(":memory:"), entered = Promise.withResolvers<void>(), frames: ServerMessage[] = [];
  const backend = makeFakeBackend({ id: kind === "other-backend" ? "claude" : "pi", async startTurn(request) {
    if (kind === "identity") request.bridge.emit({ type: "session_info", sessionId: "odysseus-existing", isNew: true });
    entered.resolve();
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
    request.bridge.emit({ type: "error", code: kind === "budget" ? "TURN_BUDGET_BLOCKED" : "agent_error",
      message: kind === "other-message" ? "A real startup failure" : "The turn was cancelled before a session was acquired.",
      ...(kind === "classified" ? { failure: { errorClass: "worker_state_busy", message: "Output staging busy" } } : {}) });
  } });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
  const authorization = testAuthorization("odysseus"); host.clients.add({ send(data) { frames.push(JSON.parse(data)); } }, "odysseus");
  const running = runSession(host, { authorization, text: "Odysseus native admission", attachments: [],
    ...(kind !== "uncorrelated" ? { requestId: "odysseus-native-request" } : {}) });
  try {
    await entered.promise;
    const turn = [...host.coordinator.running][0]!;
    if (kind === "timeout") turn.abortController.abort(new Error("Host timeout"));
    else host.coordinator.cancelTurn(turn, "Cancelled by user");
    await running;
    if (kind === "cancel") {
      expect(frames.some(frame => frame.type === "error"), "HOSTED_PI_NATIVE_CANCEL_IS_NOT_AN_ERROR").toBe(false);
      expect(frames).toContainEqual(expect.objectContaining({ type: "status", status: "cancelled", requestId: "odysseus-native-request", turnId: turn.turnId }));
      expect(frames.some(frame => frame.type === "session_info"), "CANCEL_CREATES_NO_SESSION_IDENTITY").toBe(false);
    } else {
      expect(frames.some(frame => frame.type === "error" && frame.code === (kind === "budget" ? "TURN_BUDGET_BLOCKED" : "agent_error")), "REAL_OR_UNCORRELATED_ACQUISITION_ERROR_PRESERVED").toBe(true);
      if (kind === "classified") expect(frames).toContainEqual(expect.objectContaining({ type: "error", failure: { errorClass: "worker_state_busy", message: "Output staging busy" } }));
    }
  } finally { host.coordinator.cancelAll("Fixture closing"); await running.catch(() => {}); authorization.release(); host.close(); db.close(); }
});
