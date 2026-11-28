/** One turn index per messages array (#4513): every indicator shares it. */
import { expect, test } from "bun:test";
import { turnToolIndex, turnToolIndexBuilds } from "../src/components/chat/turn-tool-index";
import type { ChatMessage } from "../src/stores/chat-store";

const answer: ChatMessage = { id: "voyage-answer", role: "assistant", content: "", isStreaming: false, timestamp: Date.UTC(2026, 6, 12, 10), turnId: "voyage",
  toolCalls: [{ id: "tool_c", name: "Grep", input: {}, inputJson: "{}", status: "complete" }, { id: "tool_c", name: "Bash", input: {}, inputJson: "{}", status: "complete" }],
  parts: [{ kind: "tool", toolIndex: 0 }, { kind: "tool", toolIndex: 1 }] };

test("the turn index is built once per messages array", () => {
  const messages = [answer], before = turnToolIndexBuilds();
  for (let i = 0; i < 25; i++) turnToolIndex(messages).get("voyage");
  expect(turnToolIndexBuilds() - before, "ONE_BUILD_PER_MESSAGES_ARRAY").toBe(1);
  const turn = turnToolIndex(messages).get("voyage")!;
  expect([...turn.drawn].map(tool => tool.name)).toEqual(["Grep", "Bash"]);
  expect(turn.firstStep.get("tool_c")?.name, "FIRST_DRAWN_STEP_CARRIES_THE_INPUT").toBe("Grep");
  turnToolIndex([...messages]);
  expect(turnToolIndexBuilds() - before, "A_NEW_ARRAY_BUILDS_AGAIN").toBe(2);
});
