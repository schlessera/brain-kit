/** A replayed live answer keeps two calls that share one tool-use ID apart
 * (#4513): the installed runtime can reuse an ID for differently named calls. */
import { beforeEach, expect, test } from "bun:test";
import { useChatStore, type ChatMessage, type ToolCall } from "../src/stores/chat-store";

const grep: ToolCall = { id: "tool_c", name: "Grep", input: { pattern: "sirens" }, inputJson: "{}", output: "notes/loom.md", status: "complete" };
const bash: ToolCall = { id: "tool_c", name: "Bash", input: { command: "cat notes/raft.md" }, inputJson: "{}", output: "The raft holds.", status: "complete" };
function answer(toolCalls: ToolCall[], text: string, streaming: boolean): ChatMessage {
  return { id: "voyage-answer", role: "assistant", content: text, isStreaming: streaming, timestamp: Date.UTC(2026, 6, 12, 10), turnId: "voyage",
    toolCalls, parts: [...toolCalls.map((_, toolIndex) => ({ kind: "tool" as const, toolIndex })), ...(text ? [{ kind: "text" as const, text }] : [])] };
}
beforeEach(() => useChatStore.setState({ buffers: {}, activeSessionId: "ithaca" }));

const running: ToolCall = { ...bash, output: undefined, status: "streaming" };
for (const [name, drawnCalls, received] of [
  ["the host's copy repeats both calls", [grep, bash], answer([grep, bash], "Odysseus", true)],
  ["the host's copy lags behind the drawn text", [grep, bash], answer([grep, bash], "", true)],
  ["the host's copy finished the second call", [grep, running], answer([grep, bash], "", true)],
] as const) test(`a replayed live pair under one ID keeps both calls: ${name}`, () => {
  useChatStore.setState({ buffers: { ithaca: { messages: [answer([...drawnCalls], "Odysseus", true)], isStreaming: true, askUser: null, lastTouched: 0 } } });
  useChatStore.getState().setMessages("ithaca", [received]);
  const [message] = useChatStore.getState().buffers.ithaca!.messages;
  const drawn = message!.parts.flatMap(part => part.kind === "tool" ? [message!.toolCalls[part.toolIndex]!] : []);
  expect(drawn.map(tool => tool.name), "REPLAYED_REUSED_ID_KEEPS_EACH_CALL").toEqual(["Grep", "Bash"]);
  expect(drawn.map(tool => tool.output)).toEqual(["notes/loom.md", "The raft holds."]);
});
