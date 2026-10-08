import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { startRelay, MODEL, type NativeCall } from "../scripts/evals/canonical-conflicts/relay";

const request = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Verify Odysseus: Ὀδυσσεύς" }] });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
function sse(cache: boolean = true, extra: Record<string, number> = {}) {
  return frame({ type: "message_start", message: { model: MODEL, usage: { input_tokens: 12, output_tokens: 0,
    ...(cache ? { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : {}), ...extra } } }) +
    frame({ type: "message_delta", usage: { output_tokens: 4, cache_read_input_tokens: null } }) + frame({ type: "message_stop" });
}
function chunks(parts: Uint8Array[]) { return new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }); }
async function send(url: string) { return fetch(`${url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer fictional-token" }, body: request }); }
function bytes(text: string) { return new TextEncoder().encode(text); }
function literal(call: NativeCall, expected: Uint8Array) {
  expect(Buffer.from(call.rawRequestBase64, "base64")).toEqual(Buffer.from(request));
  expect(Buffer.from(call.rawResponseBase64, "base64")).toEqual(Buffer.from(expected));
  expect(call.rawResponseSha).toBe(createHash("sha256").update(expected).digest("hex"));
  expect(call.responseBytes).toBe(expected.byteLength); expect(call.actualInvoiceUsd).toBeNull();
}

test("physical relay persists literal request and split SSE bytes before forwarding with nullable deltas", async () => {
  const raw = bytes(sse()), captured: string[] = [];
  const relay = startRelay({ oauthToken: "fictional-token", fetch: async (_url, init) => {
    expect(Buffer.from(init.body as Uint8Array)).toEqual(Buffer.from(request));
    return new Response(chunks([raw.slice(0, 17), raw.slice(17, 120), raw.slice(120)]));
  }, save: calls => captured.push(calls[0]!.rawResponseBase64) });
  try {
    expect(await (await send(relay.url)).text()).toBe(new TextDecoder().decode(raw));
    const call = relay.calls[0]!; literal(call, raw);
    expect(captured).toContain(Buffer.from(raw.slice(0, 17)).toString("base64"));
    expect(call.rawUsageEvents[1]!.usage.cache_read_input_tokens).toBeNull();
    expect(call.usage!.cache_read_input_tokens).toBe(0);
    expect(call.apiEquivalent).toEqual({ lowerUsd: 0.000064, upperUsd: 0.000064, unknownCacheTokens: 0 });
    expect(call.responseEof).toBe(true); expect(call.responseClosed).toBe(true); expect(call.responseCancelled).toBe(false); expect(relay.complete()).toBe(true);
  } finally { await relay.stop(); }
});

for (const missing of ["read", "creation"] as const) test(`absent ${missing} cache counter remains unknown and prevents physical known-price admission`, async () => {
  const raw = bytes(sse(false, missing === "read" ? { cache_creation_input_tokens: 0 } : { cache_read_input_tokens: 0 })); const relay = startRelay({ oauthToken: "fictional-token", fetch: async () => new Response(raw), save: () => {} });
  try {
    await expect((async () => (await send(relay.url)).text())()).rejects.toThrow();
    const call = relay.calls[0]!; literal(call, raw);
    expect(call.usage![missing === "read" ? "cache_read_input_tokens" : "cache_creation_input_tokens"]).toBeUndefined();
    expect(call.apiEquivalent).toBeNull(); expect(call.failure).toContain(missing === "read" ? "cacheReadInputTokens" : "cacheCreationInputTokens");
    expect(call.responseEof).toBe(true); expect(call.responseClosed).toBe(true); expect(relay.complete()).toBe(false);
    expect((await send(relay.url)).status).toBe(409);
  } finally { await relay.stop(); }
});

for (const kind of ["http-binary", "malformed-sse", "invalid-utf8", "missing-stop"] as const) test(`literal physical failure bytes survive: ${kind}`, async () => {
  const raw = kind === "http-binary" ? Uint8Array.from([0, 255, 128, 13, 10]) : kind === "invalid-utf8" ? Uint8Array.from([255, 0, 239]) : bytes(kind === "malformed-sse" ? "data: {broken\n\nsecond literal payload\n" : sse().replace(frame({ type: "message_stop" }), ""));
  const relay = startRelay({ oauthToken: "fictional-token", fetch: async () => new Response(chunks([raw.slice(0, 4), raw.slice(4)]), { status: kind === "http-binary" ? 529 : 200 }), save: () => {} });
  try {
    if (kind === "http-binary") { const response = await send(relay.url); expect(response.status).toBe(529); expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw); }
    else await expect((async () => (await send(relay.url)).text())()).rejects.toThrow();
    const call = relay.calls[0]!; literal(call, raw);
    expect(call.responseEof).toBe(true); expect(call.responseClosed).toBe(true); expect(call.finished).toBe(true);
    expect(call.apiEquivalent).toBeNull(); expect(relay.complete()).toBe(false);
  } finally { await relay.stop(); }
});

for (const mode of ["cancel", "shutdown"] as const) test(`physical partial ${mode} records closed unknown usage and retains observed bytes`, async () => {
  const prefix = bytes(frame({ type: "message_start", message: { model: MODEL, usage: { input_tokens: 1 } } }));
  let upstreamCancelled = false;
  const relay = startRelay({ oauthToken: "fictional-token", fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(prefix); }, cancel() { upstreamCancelled = true; } })), save: () => {} });
  try {
    const response = await send(relay.url), reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(prefix);
    if (mode === "cancel") await reader.cancel("controlled downstream cancellation"); else await relay.stop();
    for (let i = 0; i < 100 && !relay.calls[0]?.responseClosed; i++) await Bun.sleep(5);
    const call = relay.calls[0]!; literal(call, prefix);
    expect(upstreamCancelled).toBe(true); expect(call.responseCancelled).toBe(true); expect(call.responseEof).toBe(false);
    expect(call.responseClosed).toBe(true); expect(call.finished).toBe(true); expect(call.apiEquivalent).toBeNull(); expect(relay.complete()).toBe(false);
  } finally { await relay.stop(); }
});


test("physical response error retains observed prefix with unknown EOF and closed lifecycle", async () => {
  const prefix = bytes(frame({ type: "message_start", message: { model: MODEL, usage: { input_tokens: 1 } } }));
  const relay = startRelay({ oauthToken: "fictional-token", fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(prefix); }, pull(c) { c.error(Error("controlled upstream reset")); } })), save: () => {} });
  try {
    await expect((async () => (await send(relay.url)).text())()).rejects.toThrow();
    const call = relay.calls[0]!; literal(call, prefix);
    expect(call.responseEof).toBe(false); expect(call.responseClosed).toBe(true); expect(call.apiEquivalent).toBeNull(); expect(call.failure).toContain("controlled upstream reset");
  } finally { await relay.stop(); }
});

test("physical network failure retains request and explicitly unknown response without a price", async () => {
  const relay = startRelay({ oauthToken: "fictional-token", fetch: async () => { throw Error("controlled transport refusal"); }, save: () => {} });
  try {
    const response = await send(relay.url); expect(response.status).toBe(502); await response.text();
    const call = relay.calls[0]!; literal(call, new Uint8Array());
    expect(call.status).toBeNull(); expect(call.responseEof).toBe(false); expect(call.responseClosed).toBe(true); expect(call.apiEquivalent).toBeNull(); expect(call.finished).toBe(true);
  } finally { await relay.stop(); }
});
