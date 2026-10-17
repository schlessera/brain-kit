/** Keyless fresh-process probe of the host RPC and the actual curated tool. */
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createBrainAccess } from "../../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../../src/tools";
import { createTurnContext } from "../../src/turn-context";
import { pipeMessages, sendPipe } from "../../src/worker-protocol";

let brainPath = "", nextId = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const send = (value: unknown) => sendPipe(process.stdout, value);
function rpc(method: string, toolName: string, toolCallId: string, input: Record<string, unknown>) {
  const id = ++nextId;
  return new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "rpc", id, method, toolName, toolCallId, input });
  });
}
async function run(mode: string) {
  const name = "brain_read_base", id = "odysseus-base", input = { path: "notes/odysseus.md" };
  let result: unknown, isError = false;
  try {
    if (mode !== "absent") {
      const decision = await rpc("permission", mode === "forged-tool" ? "brain_read" : name, id, input);
      if (decision.behavior !== "allow") throw new Error(decision.message);
    }
    send({ type: "event", event: { type: "tool_execution_start", toolCallId: id, toolName: name, args: input } });
    if (["absent", "forged-tool", "mismatched-path", "consumed"].includes(mode)) {
      if (mode === "consumed") await rpc("readBase", name, id, input);
      result = await rpc("readBase", name, id, mode === "mismatched-path" ? { path: "notes/athena.md" } : input);
    } else {
      const turn = createTurnContext();
      turn.bridge = { emit() {}, requestPermission: async () => ({ behavior: "deny", message: "No fixture approval surface" }),
        readBrainBase: path => rpc("readBase", name, id, { path }) };
      const tools = createBrainTools({ brain: createBrainAccess(brainPath), turn, lock: toolLockFromKeyed(createKeyedLock()) });
      result = await tools.find(tool => tool.name === name)!.execute(id, input, undefined, undefined, {} as never);
    }
  } catch (error) {
    isError = true;
    result = { content: [{ type: "text", text: (error as Error).message }] };
  }
  send({ type: "event", event: { type: "tool_execution_end", toolCallId: id, toolName: name, result, isError } });
  send({ type: "done", cost: 0 });
}
for await (const message of pipeMessages(process.stdin)) {
  const value = message as any;
  if (value.type === "init") {
    brainPath = value.backend.brainPath;
    send({ type: "ready", sessionId: value.sessionId, levels: [], cost: 0 });
  } else if (value.type === "prompt") void run(value.text.split("\n", 1)[0]).catch(error => send({ type: "error", message: error.message }));
  else if (value.type === "answer") {
    const waiter = pending.get(value.id); pending.delete(value.id);
    if (value.error) waiter?.reject(new Error(value.error)); else waiter?.resolve(value.value);
  }
}
