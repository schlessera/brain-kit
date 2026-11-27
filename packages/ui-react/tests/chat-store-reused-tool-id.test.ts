/** A replayed live answer keeps two calls that share one tool-use ID apart
 * (#4513): the installed runtime can reuse an ID for differently named calls. */
import { beforeEach, expect, test } from "bun:test";
import { useChatStore, type ChatMessage, type ToolCall } from "../src/stores/chat-store";
import { attributedTool } from "../src/components/chat/safety-indicator";

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

/** Ambiguity is grow-only per turn and ID (#4513): a replay that carries
 * only one of the calls never makes that call the proven action. */
for (const [name, drawn, received] of ([
  ["a live pair replayed as its later call", answer([grep, running], "Odysseus", true), answer([bash], "Odysseus", true)],
  ["a settled pair replayed bounded to its first call", answer([grep, bash], "Odysseus", false),
    { ...answer([grep], "Odysseus\n…[1 tool calls elided]", false), parts: [{ kind: "tool" as const, toolIndex: 0 }, { kind: "text" as const, text: "Odysseus" }, { kind: "text" as const, text: "\n…[1 tool calls elided]" }] }],
] satisfies Array<[string, ChatMessage, ChatMessage]>)) test(`a reused ID stays ambiguous after ${name}`, () => {
  useChatStore.setState({ buffers: { ithaca: { messages: [drawn], isStreaming: drawn.isStreaming === true, askUser: null, lastTouched: 0 } } });
  useChatStore.getState().setMessages("ithaca", [received]);
  const buffer = useChatStore.getState().buffers.ithaca!;
  expect(buffer.ambiguousTools ?? [], "REUSED_ID_STAYS_AMBIGUOUS").toContain("voyage\0tool_c");
  const calls = buffer.messages.flatMap(message => message.toolCalls);
  expect(attributedTool(calls, "tool_c", buffer.ambiguousTools?.includes("voyage\0tool_c")), "REPLAY_NAMES_NO_ACTION").toBeNull();
  useChatStore.getState().setMessages("ithaca", [received]);
  expect(useChatStore.getState().buffers.ithaca!.ambiguousTools ?? [], "AMBIGUITY_NEVER_SHRINKS").toContain("voyage\0tool_c");
});
