/**
 * A keyless fresh-process Pi worker for the Apify bridge tools (#3162). It
 * speaks the real worker protocol: every tool call asks the host's permission
 * RPC first, then runs through the host's bridge RPC, exactly as the worker
 * entry wraps a bridge tool. It holds no Apify credential and no ledger; the
 * host answers each step with the shared envelope.
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

const INPUT = { startUrls: [{ url: "https://ithaca.example/charts" }], maxPages: 3 };
type Envelope = { ok: boolean; data?: any; error?: { code: string } };

/** One tool call as the worker entry runs it: permission, then the bridge. */
async function call(step: number, name: string, input: Record<string, unknown>, forged = false): Promise<Envelope | null> {
  const id = `odysseus-apify-${step}`;
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

async function run(mode: string) {
  if (mode === "forged") await call(0, "brain_apify_discover", { query: "sea charts" }, true);
  else if (mode === "nogrant") await call(0, "brain_apify_discover", { query: "sea charts" });
  else {
    const found = await call(0, "brain_apify_discover", { query: "sea charts" });
    const candidate = found?.data?.candidates?.[0]?.candidate;
    if (candidate) {
      await call(1, "brain_apify_inspect", { candidate });
      const prepared = await call(2, "brain_apify_prepare", { candidate, input: INPUT, max_charge_usd: 2 });
      const started = prepared?.data?.proposal ? await call(3, "brain_apify_run", { proposal: prepared.data.proposal }) : null;
      if (started?.data?.run) await call(4, "brain_apify_results", { run: started.data.run, limit: 2 });
    }
  }
  send({ type: "done", cost: 0 });
}

for await (const message of pipeMessages(process.stdin)) {
  const value = message as any;
  if (value.type === "init") send({ type: "ready", sessionId: value.sessionId, levels: [], cost: 0 });
  else if (value.type === "prompt") void run(value.text.split("\n", 1)[0]).catch(error => send({ type: "error", message: error.message }));
  else if (value.type === "answer") {
    const waiter = pending.get(value.id); pending.delete(value.id);
    if (value.error) waiter?.reject(new Error(value.error)); else waiter?.resolve(value.value);
  }
}
