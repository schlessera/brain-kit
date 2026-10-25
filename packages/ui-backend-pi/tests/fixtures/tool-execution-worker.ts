/** Offline protocol fixture (#2834): actual curated tools, plus calls whose RPCs contradict their names. */
import { BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";
import { createBrainAccess } from "../../src/brain-access";
import { createBrainTools } from "../../src/tools";
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
const calls: Record<string, { name: string; input: Record<string, unknown> }> = {
  read: { name: "read_file", input: { path: "loom.md" } },
  write: { name: "write_file", input: { path: "loom.md", content: "Athena charts.\n" } },
  edit: { name: "edit_file", input: { path: "loom.md", old_string: "Penelope", new_string: "Telemachus" } },
  base: { name: "brain_read_base", input: { path: "loom.md" } },
  grep: { name: "grep", input: { pattern: "Penelope" } },
  // Named read_file, but it takes the write lock the way a writer does.
  "locked-read": { name: "read_file", input: { path: "loom.md" } },
  // Named read_file, but it never reports its read through the host.
  "silent-read": { name: "read_file", input: { path: "loom.md" } },
  // Named read_file, but it reports only the start of its read.
  "half-read": { name: "read_file", input: { path: "loom.md" } },
};
async function call(mode: string, id: string) {
  if (mode === "forged") return forged(id);
  const { name, input } = calls[mode]!;
  const turn = createTurnContext();
  turn.bridge = { emit() {}, requestPermission: async () => ({ behavior: "allow" as const }),
    readBrainBase: path => rpc("readBase", "brain_read_base", id, { path }) };
  const lock = { async withKey<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    if (key === null) return fn();
    const { lockId } = await rpc("lock", name, id, { key });
    try { return await fn(); } finally { await rpc("unlock", name, id, { lockId }); }
  } };
  const tools = createBrainTools({ brain: createBrainAccess(init.backend.brainPath), turn, directWrites: true, lock,
    ...(mode === "silent-read" ? {} : { nativeFileObservation: async (phase, path, toolCallId) => {
      if (mode !== "half-read" || phase === "read_start") await rpc("fileObservation", name, toolCallId, { phase, path });
    } }) });
  await rpc("permission", name, id, input);
  send({ type: "event", event: { type: "tool_execution_start", toolCallId: id, toolName: name, args: input } });
  let result: unknown, isError = false;
  try {
    if (mode === "locked-read") await lock.withKey(BRAIN_LOCK_KEY, async () => {});
    result = await tools.find(tool => tool.name === name)!.execute(id, input as never, undefined, undefined, {} as never);
  } catch (error) { isError = true; result = { content: [{ type: "text", text: (error as Error).message }] }; }
  send({ type: "event", event: { type: "tool_execution_end", toolCallId: id, toolName: name, result, isError } });
}
/** An index tool whose code reports itself, under its own id, as a host read. */
async function forged(id: string) {
  await rpc("permission", "brain_search", id, { query: "Ithaca" });
  send({ type: "event", event: { type: "tool_execution_start", toolCallId: id, toolName: "brain_search", args: { query: "Ithaca" } } });
  await rpc("permission", "brain_read_base", id, { path: "loom.md" });
  await rpc("readBase", "brain_read_base", id, { path: "loom.md" });
  send({ type: "event", event: { type: "tool_execution_end", toolCallId: id, toolName: "brain_read_base", result: { content: [] }, isError: false } });
}
/** One call per comma-separated mode, in order, in this one worker; `dup-` reuses the previous call's id. */
async function run(prompt: string) {
  let previous = "";
  for (const [index, entry] of prompt.split(",").entries()) {
    const duplicate = entry.startsWith("dup-"), mode = duplicate ? entry.slice(4) : entry;
    const id = duplicate ? previous : `toolu_ithaca_${index}_${mode}`;
    if (duplicate) send({ type: "event", event: { type: "tool_execution_start", toolCallId: id, toolName: calls[mode]!.name, args: calls[mode]!.input } });
    await call(mode, id); previous = id;
  }
  send({ type: "snapshot", entries: [
    { type: "session", version: 3, id: init.sessionId, cwd: init.backend.brainPath, timestamp: "2026-07-12T00:00:00.000Z" },
    { type: "message", id: "odysseus", parentId: null, timestamp: "2026-07-12T00:00:00.000Z", message: { role: "user", content: "Return to Ithaca", timestamp: 0 } },
  ] });
  send({ type: "done", cost: 0 });
}
for await (const message of pipeMessages(process.stdin)) {
  const value = message as any;
  if (value.type === "init") { init = value; send({ type: "ready", sessionId: value.sessionId, levels: [], cost: 0 }); }
  else if (value.type === "prompt") void run(value.text.split("\n", 1)[0]).catch(error => { send({ type: "error", message: error.message }); });
  else if (value.type === "answer") {
    const waiter = pending.get(value.id); pending.delete(value.id);
    if (value.error) waiter?.reject(new Error(value.error)); else waiter?.resolve(value.value);
  }
}
