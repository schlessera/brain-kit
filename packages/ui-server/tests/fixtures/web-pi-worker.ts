/**
 * A keyless fresh-process Pi worker for the host-owned web tools (#3685). It
 * speaks the real worker protocol: each call asks the host's permission RPC,
 * then runs through the host's bridge RPC, exactly as the worker entry wraps
 * a bridge tool. It holds no provider configuration and never sees an
 * executor handle; the host answers each call with the web envelope.
 */
import { pipeMessages, sendPipe } from "../../../ui-backend-pi/src/worker-protocol";

let nextId = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const send = (value: unknown) => sendPipe(process.stdout, value);
function rpc(method: string, toolName: string, toolCallId: string, input: Record<string, unknown>) {
  const id = ++nextId;
  return new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "rpc", id, method, toolName, toolCallId, input });
  });
}
type Envelope = { ok: boolean; responseId?: string; text?: string; error?: { code: string } };

async function call(step: number, name: string, input: Record<string, unknown>, forged = false): Promise<Envelope | null> {
  const id = `odysseus-web-${step}`;
  send({ type: "event", event: { type: "tool_execution_start", toolCallId: id, toolName: name, args: input } });
  let result: unknown, isError = false, envelope: Envelope | null = null;
  try {
    if (!forged) {
      const decision = await rpc("permission", name, id, input);
      if (decision.behavior !== "allow") throw new Error(decision.message);
    }
    result = await rpc("bridge", name, id, input);
    envelope = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Envelope;
  } catch (error) {
    isError = true;
    const text = (error as Error).message;
    result = { content: [{ type: "text", text }] };
    try { envelope = JSON.parse(text) as Envelope; } catch { envelope = null; }
  }
  send({ type: "event", event: { type: "tool_execution_end", toolCallId: id, toolName: name, result, isError } });
  return envelope;
}

async function run(mode: string, detail: string) {
  if (mode === "host") {
    // The real executor (#3686): its stored results are paged by query index.
    const found = await call(0, "web_search", { query: "Odysseus mast" });
    if (found?.responseId) await call(1, "get_search_content", { responseId: found.responseId, queryIndex: 0 });
    await call(2, "fetch_content", { url: detail });
    await call(3, "source_check", { claim: "The raft reaches Ithaca at dawn" });
  } else if (mode === "host-explicit") {
    // A provider named outright (#3687), then a page.
    await call(0, "web_search", { query: "Odysseus mast", provider: "exa" });
    await call(1, "fetch_content", { url: detail });
  } else if (mode === "host-slow") await call(0, "web_search", { query: "slow Odysseus mast" });
  else if (mode === "forged") await call(0, "web_search", { query: "Odysseus mast" }, true);
  else if (mode === "unsupported") {
    await call(0, "web_search", { query: "Odysseus mast", workflow: "summary-review" });
    await call(1, "fetch_content", { url: "https://ithaca.example/log", mode: "answer", prompt: "When?" });
  } else {
    const found = await call(0, "web_search", { query: "Odysseus mast" });
    if (found?.responseId) await call(1, "get_search_content", { responseId: found.responseId });
    await call(2, "fetch_content", { url: "https://ithaca.example/log" });
    await call(3, "source_check", { claim: "The raft reached Ithaca" });
  }
  send({ type: "done", cost: 0 });
}

for await (const message of pipeMessages(process.stdin)) {
  const value = message as any;
  if (value.type === "init") send({ type: "ready", sessionId: value.sessionId, levels: [], cost: 0 });
  else if (value.type === "prompt") { const [mode, detail = ""] = value.text.split("\n"); void run(mode!, detail).catch(error => send({ type: "error", message: error.message })); }
  else if (value.type === "answer") {
    const waiter = pending.get(value.id); pending.delete(value.id);
    if (value.error) waiter?.reject(new Error(value.error)); else waiter?.resolve(value.value);
  }
}
