/** Exercise the production prompt/budget path; only native storage uses copied fixtures. */
import type { AgentBackend, ClientEnvironment, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createFixtureTurnHost } from "./turn-host-fixture.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { createTurnBudgets } from "../../packages/ui-server/src/brain/turn-budgets.js";
import { createStaticBackendRegistry } from "../../packages/ui-server/src/agent/backend.js";
import { createSessionCatalog } from "../../packages/ui-server/src/ws/session-catalog.js";
import { WsHost } from "../../packages/ui-server/src/ws/host.js";
import { runSession } from "../../packages/ui-server/src/ws/run-session.js";

export function historyHost(brainPath: string, backend: AgentBackend) {
  const db = createUiDb(":memory:");
  const native = createFixtureTurnHost(brainPath, db);
  const budgets = createTurnBudgets(db, { resolve: () => null }, () => Date.parse("2026-07-12T00:00:00Z"));
  const host = new WsHost({ ...native, brainPath, registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db), budgets, turnTimeoutMs: 30_000 });
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  const frames: ServerMessage[] = [];
  host.clients.add({ send(text) { frames.push(JSON.parse(text)); } }, "odysseus");
  return {
    async turn(text: string, client: ClientEnvironment, sessionId?: string): Promise<string> {
      frames.length = 0;
      await runSession(host, { authorization, text, client, sessionId, attachments: [], providerId: "fixture" });
      const result = frames.findLast(frame => frame.type === "result");
      if (!result || result.outcome !== "success") throw new Error(`Hosted turn failed: ${JSON.stringify(frames)}`);
      return result.sessionId;
    },
    receipts() { return db.query("SELECT receipt FROM turn_budget_usage ORDER BY rowid").all(); },
    async close() { host.close(); try { await native.close(); } finally { db.close(); } },
  };
}
