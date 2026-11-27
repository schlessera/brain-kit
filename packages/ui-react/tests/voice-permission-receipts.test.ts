import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import type { ChatMessage, ToolCall } from "../src/stores/chat-state.js";
import { createConversationPermissions, type VoicePermissionReceipt } from "../src/voice/conversation-permissions.js";

// Voice permission receipts on the transcript (#4742): a receipt replaces only
// the message that owns its tool call, and the router re-applies receipts
// only for a session whose buffer changed. Keyless: a root with no host, and
// Odysseus's voyage for the sessions.

const A = "odysseus-sirens";
const B = "odysseus-cyclops";

const roots: BrainUiRoot[] = [];
afterEach(() => { for (const r of roots.splice(0)) r.dispose(); });

function root(): BrainUiRoot {
  const r = createBrainUiRoot({ storage: null, request: async () => Response.json({ error: "not found" }, { status: 404 }) });
  roots.push(r);
  return r;
}

function tool(id: string): ToolCall {
  return { id, name: "Bash", input: {}, inputJson: "{}", status: "pending_approval" };
}

function message(id: string, role: ChatMessage["role"], toolCalls: ToolCall[] = []): ChatMessage {
  return { id, role, content: id, toolCalls, parts: [], isStreaming: false, timestamp: 1, ...(role === "assistant" ? { turnId: "turn-1" } : {}) };
}

function receipt(over: Partial<VoicePermissionReceipt> = {}): VoicePermissionReceipt {
  return { sessionId: A, turnId: "turn-1", toolUseId: "tool-mast", phase: "pending", announced: false, ambiguous: false, byVoice: false, script: "", word: "", ...over };
}

function voyage(): ChatMessage[] {
  return [
    message("m1", "user"),
    message("m2", "assistant", [tool("tool-wax")]),
    message("m3", "user"),
    message("m4", "assistant", [tool("tool-oars"), tool("tool-mast")]),
    message("m5", "user"),
  ];
}

function router(r: BrainUiRoot) {
  return createConversationPermissions(r, () => true,
    () => ({ active: false, sessionId: null, micOn: false, quiet: false, isolated: false }), () => {}, () => {});
}

const approval = (sessionId: string, toolUseId: string) =>
  ({ type: "tool_approval_request", sessionId, turnId: "turn-1", toolUseId, toolName: "Bash", input: {} }) as unknown as ServerMessage;

describe("applying a voice permission receipt", () => {
  test("only the owning message is replaced; every other message and tool call keeps its identity", () => {
    const r = root();
    r.stores.chat.getState().setMessages(A, voyage());
    const before = r.stores.chat.getState().buffers[A]!.messages;
    const stamped = receipt();
    r.stores.chat.getState().applyVoicePermission(stamped);
    const after = r.stores.chat.getState().buffers[A]!.messages;
    expect(after).not.toBe(before);
    for (const index of [0, 1, 2, 4]) expect(after[index]).toBe(before[index]!);
    expect(after[3]).not.toBe(before[3]!);
    expect(after[3]!.toolCalls[0]).toBe(before[3]!.toolCalls[0]!);
    expect(after[3]!.toolCalls[1]!.voicePermission).toBe(stamped);
    expect(after[3]!.toolCalls[1]!.status).toBe("pending_approval");
  });
});

describe("the permission router", () => {
  test("a chat write to another session applies nothing; a new buffer for the receipt's session applies it", () => {
    const r = root();
    r.stores.chat.getState().setMessages(A, voyage());
    r.stores.chat.getState().setMessages(B, [message("b1", "user")]);
    const permissions = router(r);
    try {
      permissions.frame(approval(A, "tool-mast"));
      const spy = spyOn(r.stores.chat.getState(), "applyVoicePermission");
      try {
        r.stores.chat.getState().setMessages(B, [message("b1", "user"), message("b2", "user")]);
        expect(spy).toHaveBeenCalledTimes(0);
        r.stores.chat.getState().setMessages(A, voyage());
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(r.stores.chat.getState().buffers[A]!.messages[3]!.toolCalls[1]!.voicePermission?.phase).toBe("pending");
    } finally {
      permissions.dispose();
    }
  });

  test("a receipt stored before its tool call is applied when the call arrives", () => {
    const r = root();
    r.stores.chat.getState().setMessages(A, [message("m1", "user")]);
    const permissions = router(r);
    try {
      permissions.frame(approval(A, "tool-mast"));
      expect(r.stores.chat.getState().buffers[A]!.messages.flatMap((m) => m.toolCalls)).toEqual([]);
      r.stores.chat.getState().setMessages(A, voyage());
      expect(r.stores.chat.getState().buffers[A]!.messages[3]!.toolCalls[1]!.voicePermission?.toolUseId).toBe("tool-mast");
    } finally {
      permissions.dispose();
    }
  });
});
