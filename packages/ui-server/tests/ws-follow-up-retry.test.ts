/**
 * A queued follow-up is its own turn, and so is its retry record (#4982): when
 * the follow-up's backend fails, the host saves the follow-up's request and
 * prompt for a one-click Retry, never the turn before it. Odysseus fixtures only.
 */
import { afterEach, expect, test } from "bun:test";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";
import { until } from "../../../tests/helpers/until";

const SESSION = "sess-ithaca";
const FAILURE = { errorClass: "server_error" as const, status: 500, message: "Provider failed" };

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

test("a failed queued follow-up saves its own retry request and prompt, not the previous turn's", async () => {
  const db = createUiDb(":memory:");
  const prompts: string[] = [], finishers: Array<() => void> = [];
  let results = 0;
  const backend = makeFakeBackend({
    id: "fake",
    startTurn: async ({ bridge, prompt, signal }) => {
      prompts.push(prompt);
      bridge.emit({ type: "session_info", sessionId: SESSION, isNew: prompts.length === 1 });
      // The first turn runs until the follow-up is queued behind it.
      if (prompts.length === 1) await new Promise<void>((resolve) => { finishers.push(resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
      bridge.emit({ type: "result", sessionId: SESSION, outcome: "error", durationMs: 1, numTurns: 1, isError: true, failure: FAILURE });
      results++;
    },
  });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
  cleanup = () => { for (const finish of finishers) finish(); host.close(); db.close(); };
  const handlers = createWsHandlers(host, testPrincipal());
  const ws = { send: () => {} } as unknown as WSContext;
  await handlers.onOpen(undefined as never, ws);
  const send = (frame: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);

  send({ type: "chat_message", text: "Chart the way home", requestId: "req-first" });
  await until(() => finishers.length === 1 && host.coordinator.bySession.has(SESSION));
  send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
  await until(() => host.coordinator.bySession.get(SESSION)?.queue.length === 1);
  finishers[0]!();
  // The retry record is saved while the failed result is emitted, before `results` counts it.
  await until(() => results === 2);

  const saved = db.query("SELECT request_json, prompt FROM retry_requests WHERE session_id = ?").get(SESSION) as { request_json: string; prompt: string } | null;
  expect(prompts).toHaveLength(2);
  expect(saved && JSON.parse(saved.request_json), "FOLLOW_UP_SAVES_ITS_OWN_REQUEST").toMatchObject({ type: "chat_message", text: "Ask Aeolus about the winds" });
  expect(saved?.prompt, "FOLLOW_UP_SAVES_ITS_OWN_PROMPT").toBe(prompts[1]!);
});
