import { afterEach, beforeEach, expect, test } from "bun:test";
import type { WSContext } from "../src/ws/clients";
import { queryGovernanceEvents } from "../src/governance/events";
import { makeFakeBackend } from "./helpers/fake-backend";
import { addClient, closeDb, getDb, handleClientMessage, removeDbFile, resetForTests, setBackendsForTests, testHost, useTestDb } from "./helpers/test-host";

const TEST_DB = `/tmp/brain-ui-turn-temp-promotion-${process.pid}.db`;
beforeEach(() => { resetForTests(); closeDb(); removeDbFile(TEST_DB); useTestDb(TEST_DB); });
afterEach(() => { resetForTests(); closeDb(); removeDbFile(TEST_DB); });

test("a backend's promotions become governance events of the host's turn, and the chat gets only the rewritten links (#1655, #1698)", async () => {
  let hostTurnId = "", requestTurnId: string | undefined;
  setBackendsForTests([makeFakeBackend({
    id: "claude",
    async startTurn(req) {
      hostTurnId = [...testHost().coordinator.running][0]!.turnId;
      requestTurnId = req.turnId;
      req.bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
      const destination = `.brain/scratch/turns/${req.turnId}/report.pdf`;
      req.bridge.activity?.({ kind: "promotion", source: "/tmp/brain-worker-scratch/report.pdf", destination, bytes: 28,
        originalLink: "/tmp/brain-worker-scratch/report.pdf", rewrittenLink: destination,
        aliases: [{ originalLink: "$BRAIN_WORKER_SCRATCH/report.pdf#page=2", rewrittenLink: `${destination}#page=2` }] });
      // Reported twice (a retried spawn): still one record.
      req.bridge.activity?.({ kind: "promotion", source: "/tmp/brain-worker-scratch/report.pdf", destination, bytes: 28,
        originalLink: "/tmp/brain-worker-scratch/report.pdf", rewrittenLink: destination });
      req.bridge.activity?.({ kind: "promotion_refused", source: "/tmp/brain-worker-scratch/secret.txt",
        originalLink: "/tmp/brain-worker-scratch/secret.txt", reason: "symlink", bytes: null, limitBytes: null });
      req.bridge.emit({ type: "result", sessionId: "sess-ithaca", numTurns: 1, durationMs: 1, isError: false, outcome: "success" });
    },
  })], "claude");
  const frames: Array<{ type: string } & Record<string, unknown>> = [];
  const ws: WSContext = { send: (data) => frames.push(JSON.parse(data)) };
  addClient(ws);
  await handleClientMessage(ws, { type: "chat_message", text: "Write up the voyage report", attachments: [] });
  for (let i = 0; i < 200 && (!frames.some((f) => f.type === "result") || testHost().coordinator.isTurnActive()); i++) await Bun.sleep(5);

  expect(hostTurnId).not.toBe("");
  expect(requestTurnId).toBe(hostTurnId);
  const events = queryGovernanceEvents(getDb(), { sessionId: "sess-ithaca", limit: 10 });
  expect(events.map(({ id: _id, at: _at, ...event }) => event)).toEqual([
    { sessionId: "sess-ithaca", turnId: hostTurnId, kind: "promotion", schemaVersion: 1, actor: "interactive", model: null, profile: null,
      payload: { source: "/tmp/brain-worker-scratch/report.pdf", destination: `.brain/scratch/turns/${hostTurnId}/report.pdf`, bytes: 28,
        originalLink: "/tmp/brain-worker-scratch/report.pdf", rewrittenLink: `.brain/scratch/turns/${hostTurnId}/report.pdf` } },
    { sessionId: "sess-ithaca", turnId: hostTurnId, kind: "promotion_refused", schemaVersion: 1, actor: "interactive", model: null, profile: null,
      payload: { source: "/tmp/brain-worker-scratch/secret.txt", originalLink: "/tmp/brain-worker-scratch/secret.txt", reason: "symlink",
        bytes: null, limitBytes: null } },
  ]);
  // The aliases say what the live view rewrites; the record is about the file.
  const links = frames.filter((f) => f.type === "message_links");
  expect(links).toEqual([{ type: "message_links", sessionId: "sess-ithaca", turnId: hostTurnId, links: [
    { from: "/tmp/brain-worker-scratch/report.pdf", to: `.brain/scratch/turns/${hostTurnId}/report.pdf` },
    { from: "$BRAIN_WORKER_SCRATCH/report.pdf#page=2", to: `.brain/scratch/turns/${hostTurnId}/report.pdf#page=2` },
  ] }]);
  // Nothing else, and nothing about the refusal or the record, reaches the chat.
  expect(JSON.stringify(frames.filter((f) => f.type !== "message_links"))).not.toMatch(/promot|brain-worker-scratch|scratch\/turns/);
});

test("an invalid promotion report is dropped without failing the turn", async () => {
  setBackendsForTests([makeFakeBackend({
    id: "claude",
    async startTurn(req) {
      req.bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
      req.bridge.activity?.({ kind: "promotion_refused", source: "", originalLink: "x", reason: "symlink", bytes: null, limitBytes: null });
      req.bridge.emit({ type: "result", sessionId: "sess-ithaca", numTurns: 1, durationMs: 1, isError: false, outcome: "success" });
    },
  })], "claude");
  const frames: Array<{ type: string; outcome?: string }> = [];
  const ws: WSContext = { send: (data) => frames.push(JSON.parse(data)) };
  addClient(ws);
  await handleClientMessage(ws, { type: "chat_message", text: "Write up the voyage report", attachments: [] });
  for (let i = 0; i < 200 && (!frames.some((f) => f.type === "result") || testHost().coordinator.isTurnActive()); i++) await Bun.sleep(5);
  expect(frames.find((f) => f.type === "result")?.outcome).toBe("success");
  expect(queryGovernanceEvents(getDb(), { limit: 10 })).toEqual([]);
});
