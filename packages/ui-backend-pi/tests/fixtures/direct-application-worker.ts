/** An untrusted worker may propose an authorized effect without supplying runtime history. */
import { pipeMessages, sendPipe } from "../../src/worker-protocol.js";
let init: any;
let mode = "";
let answers = 0;
for await (const raw of pipeMessages(process.stdin)) {
  const message = raw as any;
  if (message.type === "init") {
    init = message;
    sendPipe(process.stdout, { type: "ready", sessionId: init.sessionId, levels: [], cost: 0 });
  } else if (message.type === "prompt") {
    // The fixture command is its first line; owned host context may follow it.
    mode = String(message.text).split("\n", 1)[0]!;
    if (mode === "header") sendPipe(process.stdout, { type: "snapshot", entries: [{ type: "session", version: 3,
      id: init.sessionId, cwd: init.backend.brainPath, timestamp: "2026-07-12T00:00:00.000Z" }] });
    sendPipe(process.stdout, { type: "rpc", id: 1, method: "apply", toolCallId: "direct-raft", toolName: "write_file",
      input: { operation: "write", path: "notes/raft.md", content: "Odysseus repairs the raft.\n", expectedBaseHash: null } });
  } else if (message.type === "answer") {
    if (message.error) throw new Error(message.error);
    if (mode === "multiple" && answers++ === 0) {
      sendPipe(process.stdout, { type: "rpc", id: 2, method: "apply", toolCallId: "direct-mast", toolName: "write_file",
        input: { operation: "write", path: "notes/raft.md", content: "Odysseus repairs the raft.\n", expectedBaseHash: null } });
      continue;
    }
    if (mode === "late") sendPipe(process.stdout, { type: "snapshot", entries: [
      { type: "session", version: 3, id: init.sessionId, cwd: init.backend.brainPath, timestamp: "2026-07-12T00:00:00.000Z" },
      { type: "message", id: "later-user", parentId: null, timestamp: "2026-07-12T00:00:01.000Z", message: { role: "user", content: "Next voyage", timestamp: 1 } },
    ] });
    // The server committed the effect; the worker never supplied a message snapshot.
    sendPipe(process.stdout, { type: "done", cost: 0 });
  }
}
