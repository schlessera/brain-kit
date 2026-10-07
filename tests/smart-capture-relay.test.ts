import { expect, test } from "bun:test";
import { startRelay, MODEL } from "../scripts/evals/smart-capture/relay";

function sse(text = "Θάλασσα") {
  const frames = [
    { type: "message_start", message: { id: "msg_fixture", model: MODEL, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 } } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  return frames.map(f => `event: ${f.type}\r\ndata: ${JSON.stringify(f)}\r\n\r\n`).join("");
}
async function send(url: string, model = MODEL, token = "offline-token") {
  return fetch(`${url}/v1/messages?beta=true`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "A fictional raft note" }] }) });
}
test("actual loopback relay counts separate main/helper calls and keeps split UTF8 streaming bytes", async () => {
  const raw = sse(), bytes = new TextEncoder().encode(raw); let saved = 0;
  const relay = startRelay({ oauthToken: "offline-token", upstream: "http://127.0.0.1:1", save: () => saved++,
    async fetch(url, init) {
      expect(url).toBe("http://127.0.0.1:1/v1/messages?beta=true");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer offline-token");
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    expect(await (await send(relay.url)).text()).toBe(raw);
    expect(await (await send(relay.url)).text()).toBe(raw);
    expect(relay.calls).toHaveLength(2);
    expect(relay.complete()).toBe(true);
    expect(relay.calls.map(c => c.usage!.output_tokens)).toEqual([7, 7]);
    expect(relay.calls[0]!.apiEquivalent!.upperUsd).toBeCloseTo(0.0001031, 8);
    expect(saved).toBeGreaterThan(3);
  } finally { relay.stop(); }
});
test("missing final message usage is retained and refuses subsequent physical dispatch", async () => {
  let dispatches = 0;
  const relay = startRelay({ oauthToken: "offline-token", save: () => {}, async fetch() { dispatches++; return new Response(dispatches === 1 ? 'data: {"type":"message_stop"}\n\n' : sse(), { headers: { "content-type": "text/event-stream" } }); } });
  try {
    // Bun may reject before headers or while reading an already returned body.
    // Either way, the actual usage receipt and next-dispatch guard must hold.
    await send(relay.url).then(response => response.text()).catch(() => {});
    expect(relay.calls[0]!.outcome).toBe("missing_usage");
    expect(relay.calls[0]!.apiEquivalent).toBeNull();
    expect(relay.complete()).toBe(false);
    expect((await send(relay.url)).status).toBe(409);
    expect(dispatches).toBe(1);
  } finally { relay.stop(); }
});
test("unexpected model, API key and wrong OAuth never reach the upstream", async () => {
  for (const mode of ["model", "token", "key"]) {
    let dispatches = 0;
    const relay = startRelay({ oauthToken: "offline-token", save: () => {}, async fetch() { dispatches++; return new Response(sse()); } });
    try {
      const response = mode === "key" ? await fetch(`${relay.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer offline-token", "x-api-key": "offline-key" }, body: JSON.stringify({ model: MODEL }) }) : await send(relay.url, mode === "model" ? "claude-sonnet-5" : MODEL, mode === "token" ? "wrong-token" : "offline-token");
      expect(dispatches).toBe(0); expect(response.status).toBe(403); expect(relay.calls).toHaveLength(0);
    } finally { relay.stop(); }
  }
});
