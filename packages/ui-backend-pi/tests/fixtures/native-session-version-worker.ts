/** Offline protocol fixture: actual curated native tools in a fresh process per turn. */
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createBrainAccess } from "../../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../../src/tools";
import { createTurnContext } from "../../src/turn-context";
import { pipeMessages, sendPipe } from "../../src/worker-protocol";

let init: any, nextId = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const send = (value: unknown) => sendPipe(process.stdout, value);
function rpc(method: string, toolName: string, toolCallId: string, input: Record<string, unknown>) {
  const id = ++nextId;
  return new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject }); send({ type: "rpc", id, method, toolName, toolCallId, input });
  });
}
async function run(mode: string) {
  const name = mode === "write" ? "write_file" : "read_file", id = "toolu_ithaca_native";
  const input = name === "read_file" ? { path: "loom.md" } : { path: "loom.md", content: "Athena charts.\n" };
  const turn = createTurnContext();
  const tools = createBrainTools({ brain: createBrainAccess(init.backend.brainPath), turn, directWrites: true,
    lock: toolLockFromKeyed(createKeyedLock()),
    nativeFileObservation: async (phase, path, toolCallId) => { await rpc("fileObservation", name, toolCallId, { phase, path }); } });
  await rpc("permission", name, id, input);
  send({ type: "event", event: { type: "tool_execution_start", toolCallId: id, toolName: name, args: input } });
  let result: unknown, isError = false;
  try { result = await tools.find(tool => tool.name === name)!.execute(id, input, undefined, undefined, {} as never); }
  catch (error) { isError = true; result = { content: [{ type: "text", text: (error as Error).message }] }; }
  send({ type: "event", event: { type: "tool_execution_end", toolCallId: id, toolName: name, result, isError } });
  send({ type: "snapshot", entries: [
    { type: "session", version: 3, id: init.sessionId, cwd: init.backend.brainPath, timestamp: "2026-07-12T00:00:00.000Z" },
    { type: "message", id: "odysseus", parentId: null, timestamp: "2026-07-12T00:00:00.000Z", message: { role: "user", content: "Return to Ithaca", timestamp: 0 } },
  ] });
  send({ type: "done", cost: 0 });
}
for await (const message of pipeMessages(process.stdin)) {
  const value = message as any;
  if (value.type === "init") { init = value; send({ type: "ready", sessionId: value.sessionId, levels: [], cost: 0 }); }
  else if (value.type === "prompt") void run(value.text).catch(error => { send({ type: "error", message: error.message }); });
  else if (value.type === "answer") {
    const waiter = pending.get(value.id); pending.delete(value.id);
    if (value.error) waiter?.reject(new Error(value.error)); else waiter?.resolve(value.value);
  }
}
