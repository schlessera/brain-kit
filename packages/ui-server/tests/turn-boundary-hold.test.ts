import { expect, test } from "bun:test";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createRecordingObservability } from "../src/observability/index";
import type { SessionCatalog } from "../src/ws/session-catalog";
import { FailureReplay } from "../src/ws/turn-failures";

// The result-to-finish hold (#3803): a history read of a session waits for
// its turn's boundary, never for another session's, and never for longer
// than the boundary deadline.

const answer = (content: string): SessionHistoryMessage => ({ role: "assistant", content, toolCalls: [] } as unknown as SessionHistoryMessage);

function setup(boundaryReadMs?: number) {
  const recorded: string[] = [];
  const catalog = { recordTurnBoundary: (_sessionId: string, _backendId: string, boundary: { turnId: string }) => { recorded.push(boundary.turnId); } } as unknown as SessionCatalog;
  let history: SessionHistoryMessage[] = [];
  const backend = { id: "claude", getHistory: async () => structuredClone(history) } as unknown as AgentBackend;
  const replay = new FailureReplay(catalog, createRecordingObservability().logger("turn"), boundaryReadMs);
  const pending = () => (replay as unknown as { pending: Map<string, Set<Promise<void>>> }).pending;
  return { replay, backend, recorded, pending, answer: (content: string) => { history = [...history, answer(content)]; } };
}

/** Whether `promise` settles within a few event-loop turns. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  for (let i = 0; i < 20 && !done; i++) await Bun.sleep(1);
  return done;
}

test("a held session's reads wait for its boundary; an unrelated session's do not", async () => {
  const h = setup();
  const turn = await h.replay.begin(h.backend, "ithaca", "turn-ithaca", new AbortController().signal);
  h.answer("The ship is rostered.");
  turn.resulted("ithaca");
  expect(await settlesSoon(h.replay.wait("aeaea")), "another session reads at once").toBe(true);
  const held = h.replay.wait("ithaca");
  expect(await settlesSoon(held), "this session waits for its turn's end").toBe(false);
  await turn.finish("ithaca");
  expect(await settlesSoon(held), "and reads once the boundary is recorded").toBe(true);
  expect(h.recorded).toEqual(["turn-ithaca"]);
  expect(h.pending().size, "no pending entry is left").toBe(0);
});

test("a teardown that never finishes releases the hold at the boundary deadline", async () => {
  const h = setup(50);
  const turn = await h.replay.begin(h.backend, "ithaca", "turn-ithaca", new AbortController().signal);
  turn.resulted("ithaca");
  const held = h.replay.wait("ithaca");
  expect(await settlesSoon(held), "held before the deadline").toBe(false);
  await Bun.sleep(80);
  expect(await settlesSoon(held), "released by the deadline without a finish").toBe(true);
  expect(h.pending().size, "no pending entry is left").toBe(0);
  expect(h.recorded, "no boundary is made up").toEqual([]);
});
