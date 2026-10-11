import { afterEach, beforeEach, expect, test } from "bun:test";
import type { WSContext } from "../src/ws/clients";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";
import { makeFakeBackend } from "./helpers/fake-backend";
import { addClient, closeDb, getDb, handleClientMessage, removeDbFile, resetForTests, setBackendsForTests, testHost, useTestDb } from "./helpers/test-host";

const TEST_DB = `/tmp/brain-ui-governance-binding-${process.pid}.db`;
beforeEach(() => { resetForTests(); closeDb(); removeDbFile(TEST_DB); useTestDb(TEST_DB); });
afterEach(() => { resetForTests(); closeDb(); removeDbFile(TEST_DB); });

test("a new conversation's governance events written before session_info join its session", async () => {
  let turnId = "";
  setBackendsForTests([makeFakeBackend({
    id: "claude",
    async startTurn(req) {
      // Launch-time intervention: the session has no id yet.
      turnId = [...testHost().coordinator.running][0]!.turnId;
      recordGovernanceEvent(getDb(), { kind: "strict_fallback", payload: { path: ".claude/settings.json", reason: "symlink" },
        sessionId: null, turnId, actor: "interactive", model: null, profile: "strict" });
      req.bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
      req.bridge.emit({ type: "result", sessionId: "sess-ithaca", numTurns: 1, durationMs: 1, isError: false, outcome: "success" });
    },
  })], "claude");
  const frames: Array<{ type: string }> = [];
  const ws: WSContext = { send: (data) => frames.push(JSON.parse(data)) };
  addClient(ws);
  await handleClientMessage(ws, { type: "chat_message", text: "Plot a course for Ithaca", attachments: [] });
  for (let i = 0; i < 200 && (!frames.some((f) => f.type === "result") || testHost().coordinator.isTurnActive()); i++) await Bun.sleep(5);

  expect(turnId).not.toBe("");
  const events = queryGovernanceEvents(getDb(), { sessionId: "sess-ithaca", limit: 10 });
  expect(events.map((e) => [e.turnId, e.kind])).toEqual([[turnId, "strict_fallback"]]);
  getDb().query("DELETE FROM sessions WHERE id = 'sess-ithaca'").run();
  expect(queryGovernanceEvents(getDb(), { limit: 10 })).toEqual([]);
});
