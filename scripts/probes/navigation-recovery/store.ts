import { mkdir } from "node:fs/promises";
await mkdir(process.argv[2] ?? "/tmp/brain-navigation-recovery", {
  recursive: true,
});
import { createBrainUiRoot } from "../../../packages/ui-react/src/root.ts";
import { strict as assert } from "node:assert";
const frames: any = {
  running: { type: "text_delta", text: "Timber is packed." },
  queued: {
    type: "status",
    status: "queued",
    detail: "Waiting behind another voyage",
  },
  approval: {
    type: "tool_approval_request",
    toolUseId: "write-raft",
    toolName: "Write",
    input: { file_path: "notes/raft.md", content: "Timber and rope" },
    description: "Record raft supplies",
  },
  ask: {
    type: "ask_user_request",
    requestId: "ask-raft",
    questions: [
      {
        question: "Which supply?",
        header: "Raft",
        options: [
          { label: "Rope", description: "Pack rope" },
          { label: "Timber", description: "Pack timber" },
        ],
        multiSelect: false,
      },
    ],
  },
  list: {
    type: "ask_user_list_request",
    requestId: "list-raft",
    prompt: "Classify raft supplies",
    items: [{ id: "rope", label: "Rope" }],
    scale: [{ label: "Pack" }, { label: "Leave" }],
    allowSkip: false,
    notes: false,
  },
  rank: {
    type: "ask_user_rank_request",
    requestId: "rank-raft",
    prompt: "Order supplies",
    items: [
      { id: "rope", label: "Rope" },
      { id: "timber", label: "Timber" },
    ],
  },
  form: {
    type: "ask_user_form_request",
    requestId: "form-raft",
    prompt: "Supply note",
    nodes: [
      { id: "note", kind: "text", prompt: "Supply note", required: true },
    ],
    maxDepth: 3,
    maxNodes: 10,
    maxOptions: 10,
  },
  success: {
    type: "result",
    isError: false,
    outcome: "success",
    durationMs: 1,
    numTurns: 1,
  },
  failure: {
    type: "result",
    isError: true,
    outcome: "error",
    durationMs: 1,
    numTurns: 1,
  },
};
const results: any[] = [];
for (const [kind, frame] of Object.entries(frames))
  for (const transition of ["A-to-B", "New-chat", "overflow", "fresh-root"]) {
    const data = new Map<string, string>();
    const storage: any = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
      removeItem: (k: string) => data.delete(k),
    };
    const make = () =>
      createBrainUiRoot({
        storage,
        storagePrefix: "odysseus-store-probe",
        request: async () => Response.json({ live: [], history: [] }),
      });
    let root = make();
    const c = root.stores.chat.getState();
    c.setActiveSession("A");
    c.addUserMessage("A", "Pack raft supplies");
    if (kind !== "queued") c.startAssistantMessage("A");
    root.connection.handleServerMessage({
      ...(frame as Record<string, unknown>),
      sessionId: "A",
      turnId: "turn-A",
    } as any);
    root.connection.flushChatDeltas();
    const before = root.stores.chat.getState();
    assert(before.buffers.A?.messages.length, "nonempty observed input");
    const input = {
      streaming: before.buffers.A.isStreaming,
      ask: before.buffers.A.askUser?.requestId ?? null,
      approvals: before.buffers.A.messages
        .flatMap((m) => m.toolCalls)
        .filter((t) => t.status === "pending_approval").length,
      run: before.runStates.A ?? null,
    };
    if (kind === "approval")
      assert.equal(input.approvals, 1, "approval input nonempty");
    if (["ask", "list", "rank", "form"].includes(kind))
      assert(input.ask, "ask input nonempty");
    if (transition === "A-to-B") c.setActiveSession("B");
    else if (transition === "New-chat") c.clearMessages();
    else if (transition === "overflow")
      for (let i = 0; i < 12; i++) c.setActiveSession("idle-" + i);
    else {
      root.dispose();
      root = make();
    }
    const after = root.stores.chat.getState();
    results.push({
      kind,
      transition,
      input,
      active: after.activeSessionId,
      retained: !!after.buffers.A,
      count: Object.keys(after.buffers).length,
      run: after.runStates.A ?? null,
      ask: after.buffers.A?.askUser?.requestId ?? null,
      storageKeys: [...data.keys()],
    });
    root.dispose();
  }
const r = createBrainUiRoot({ storage: null });
const c = r.stores.chat.getState();
c.setActiveSession("A");
c.addUserMessage("A", "Pack timber");
c.startAssistantMessage("A");
r.connection.handleServerMessage({
  type: "text_delta",
  sessionId: "A",
  turnId: "turn-A",
  text: "A continues.",
});
r.connection.flushChatDeltas();
c.clearMessages();
c.setActiveSession("B");
r.connection.handleServerMessage({
  type: "text_delta",
  sessionId: "A",
  turnId: "turn-A",
  text: " A finishes.",
});
const result = {
  type: "result" as const,
  sessionId: "A",
  turnId: "turn-A",
  outcome: "success" as const,
  isError: false,
  durationMs: 1,
  numTurns: 1,
};
r.connection.handleServerMessage(result);
const s = r.stores.chat.getState();
assert.equal(s.activeSessionId, "B");
assert.equal(s.buffers.A.messages.at(-1)?.content, "A continues. A finishes.");
assert.equal(s.buffers.B.messages.length, 0);
results.push({
  kind: "background-completion",
  active: "B",
  content: s.buffers.A.messages.at(-1)?.content,
  B: s.buffers.B.messages.length,
});
r.dispose();
await Bun.write(
  `${process.argv[2] ?? "/tmp/brain-navigation-recovery"}/store.json`,
  JSON.stringify(results, null, 2)
);
console.log("stored scenarios", results.length);
