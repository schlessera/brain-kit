/**
 * The CLI provider relay's host policy (#1673): fixed first-party routes,
 * exact recipients per key, credential replacement, budget refusal before
 * contact, no redirects, and raw usage read before any SDK conversion.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import {
  FIRST_PARTY_PROVIDER_RECIPIENTS, MAX_PROVIDER_CONCURRENT_REQUESTS, parseCliProviderOrigins, providerUsage, startProviderRelay, type ProviderRelayOptions,
  type ProviderRelayReceipt, type ProviderRelayRefusal,
} from "../src/server/provider-relay.js";

let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ path: string; headers: Record<string, string>; body: string }> = [];
let reply: (path: string) => Response = () => Response.json({ usage: { input_tokens: 7, output_tokens: 3 } });
beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    seen.push({ path: url.pathname, headers: Object.fromEntries(request.headers), body: await request.text() });
    return reply(url.pathname);
  } });
});
afterAll(() => upstream.stop(true));

const KEYS: Record<string, string> = { ANTHROPIC_API_KEY: "odysseus-host-anthropic", GEMINI_API_KEY: "odysseus-host-gemini",
  OPENAI_API_KEY: "odysseus-host-openai", ITHACA_GATEWAY_KEY: "odysseus-host-gateway" };

async function relayed(options: Partial<ProviderRelayOptions>, request: { path: string; family?: string; key?: string; origin?: string;
  method?: string; headers?: Record<string, string>; body?: string | Uint8Array }) {
  const receipts: ProviderRelayReceipt[] = [], dispatched: ProviderRelayReceipt[] = [], refusals: ProviderRelayRefusal[] = [];
  const relay = startProviderRelay({ credential: name => KEYS[name], origins: new Map([["ANTHROPIC_API_KEY", [upstream.url.origin]]]),
    observe: receipt => (receipt.outcome === "dispatched" ? dispatched : receipts).push(receipt), refused: refusal => refusals.push(refusal), ...options });
  seen.length = 0;
  try {
    const headers: Record<string, string> = { "content-type": "application/json", "x-brain-provider": request.family ?? "anthropic",
      "x-brain-provider-key": request.key ?? "ANTHROPIC_API_KEY", "x-brain-provider-origin": request.origin ?? upstream.url.origin, ...request.headers };
    const body = request.method === "GET" ? undefined : Buffer.from(request.body ?? JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [] }));
    // node:http over the socket: an in-process Bun fetch to its own Unix server stalls.
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = httpRequest({ socketPath: relay.socketPath, method: request.method ?? "POST", path: request.path,
        headers: { ...headers, ...(body ? { "content-length": String(body.byteLength) } : {}) } }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
    return { ...response, receipts, dispatched, refusals, upstream: [...seen] };
  } finally { await relay.stop(); }
}

describe("recipient authority", () => {
  test("a listed origin receives only the host's key, in the family's own header", async () => {
    const result = await relayed({}, { path: "/v1/messages", headers: { authorization: "Bearer odysseus-worker-token",
      "x-goog-api-key": "odysseus-worker-gemini", "x-api-key": "brain-provider-relay-placeholder", cookie: "penelope=1" } });
    expect(result.status).toBe(200);
    expect(result.upstream).toHaveLength(1);
    const headers = result.upstream[0]!.headers;
    expect(headers["x-api-key"], "RELAY_PLACES_HOST_KEY").toBe(KEYS.ANTHROPIC_API_KEY);
    expect(["authorization", "x-goog-api-key", "cookie", "x-brain-provider", "x-brain-provider-key", "x-brain-provider-origin"]
      .filter(name => headers[name] !== undefined), "RELAY_STRIPS_WORKER_CREDENTIALS").toEqual([]);
    expect(result.receipts).toMatchObject([{ family: "anthropic", operation: "completions", model: "claude-haiku-4-5-20251001",
      origin: upstream.url.origin, key: "ANTHROPIC_API_KEY", outcome: "completed", usage: { inputTokens: 7, outputTokens: 3 } }]);
  });

  test("an unlisted origin is refused before contact, naming the setting", async () => {
    const result = await relayed({ origins: new Map() }, { path: "/v1/messages" });
    expect(result.upstream, "UNLISTED_ORIGIN_NOT_CONTACTED").toEqual([]);
    expect(result.status).toBe(403);
    expect(result.body).toContain(`ANTHROPIC_API_KEY=${upstream.url.origin} in BRAIN_UI_CLI_PROVIDER_ORIGINS`);
    expect(result.upstream, "UNLISTED_ORIGIN_NOT_CONTACTED").toEqual([]);
    expect(result.refusals).toMatchObject([{ reason: "recipient_not_authorized" }]);
  });

  test("a custom key variable needs its own listing; another key's listing never covers it", async () => {
    const refused = await relayed({}, { path: "/v1/messages", key: "ITHACA_GATEWAY_KEY" });
    expect(refused.status, "CUSTOM_KEY_UNLISTED_REFUSED").toBe(403);
    expect(refused.upstream).toEqual([]);
    const listed = await relayed({ origins: new Map([["ITHACA_GATEWAY_KEY", [upstream.url.origin]]]) }, { path: "/v1/messages", key: "ITHACA_GATEWAY_KEY" });
    expect(listed.status).toBe(200);
    expect(listed.upstream[0]!.headers["x-api-key"]).toBe(KEYS.ITHACA_GATEWAY_KEY);
  });

  test("first-party defaults pair each key with its own origin only", async () => {
    expect(FIRST_PARTY_PROVIDER_RECIPIENTS).toEqual({
      gemini: { key: "GEMINI_API_KEY", origin: "https://generativelanguage.googleapis.com" },
      anthropic: { key: "ANTHROPIC_API_KEY", origin: "https://api.anthropic.com" },
      openai: { key: "OPENAI_API_KEY", origin: "https://api.openai.com" },
    });
    // Gemini's key toward Anthropic's first-party origin is not a default pair.
    const crossed = await relayed({ origins: new Map() }, { path: "/v1/messages", key: "GEMINI_API_KEY", origin: "https://api.anthropic.com" });
    expect(crossed.status).toBe(403);
    expect(crossed.refusals).toMatchObject([{ reason: "recipient_not_authorized" }]);
  });

  test("a missing host key is refused without contact", async () => {
    const result = await relayed({ credential: () => undefined }, { path: "/v1/messages" });
    expect(result.status).toBe(403);
    expect(result.refusals).toMatchObject([{ reason: "credential_unavailable" }]);
    expect(result.upstream).toEqual([]);
  });
});

describe("routes", () => {
  test.each([
    ["GET on a relayed path", { path: "/v1/messages", method: "GET" }, "method_not_allowed"],
    ["an unrelayed path", { path: "/v1/files" }, "route_not_allowed"],
    ["a query string", { path: "/v1/messages?beta=true" }, "route_not_allowed"],
    ["another family's route", { path: "/v1beta/models/gemini-embedding-2:embedContent" }, "route_not_allowed"],
    ["an unknown family", { path: "/v1/messages", family: "jev" }, "unknown_family"],
    ["a video upload route", { path: "/upload/v1beta/files", family: "gemini", key: "GEMINI_API_KEY" }, "route_not_allowed"],
  ] as const)("%s is refused before contact", async (_, request, reason) => {
    const result = await relayed({}, request);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.refusals).toMatchObject([{ reason }]);
    expect(result.upstream).toEqual([]);
  });

  test("a redirect is never followed and its spend stays unknown", async () => {
    reply = () => new Response(null, { status: 307, headers: { location: "https://sirens.example/v1/messages" } });
    try {
      const result = await relayed({}, { path: "/v1/messages" });
      expect(result.status, "RELAY_REFUSES_REDIRECT").toBe(502);
      expect(result.upstream).toHaveLength(1);
      expect(result.receipts).toMatchObject([{ outcome: "failed", status: 307, usage: null }]);
    } finally { reply = () => Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }); }
  });

  test("a multipart image edit keeps its bytes and names its model", async () => {
    const form = new FormData();
    form.append("model", "gpt-image-2.5-flare");
    form.append("image[]", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "ithaca.png");
    const body = new Request("http://localhost", { method: "POST", body: form });
    reply = () => Response.json({ data: [], usage: { input_tokens: 100, output_tokens: 1000 } });
    try {
      const result = await relayed({ origins: new Map([["OPENAI_API_KEY", [upstream.url.origin]]]) }, { path: "/v1/images/edits", family: "openai",
        key: "OPENAI_API_KEY", headers: { "content-type": body.headers.get("content-type")! }, body: new Uint8Array(await body.arrayBuffer()) });
      expect(result.status).toBe(200);
      expect(result.upstream[0]!.headers.authorization).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
      expect(result.upstream[0]!.headers["content-type"]).toStartWith("multipart/form-data; boundary=");
      expect(result.receipts).toMatchObject([{ family: "openai", operation: "image", model: "gpt-image-2.5-flare",
        usage: { inputTokens: 100, outputTokens: 1000 } }]);
    } finally { reply = () => Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }); }
  });
});

describe("budget", () => {
  test("a blocked scope refuses the next request with budget_exceeded before contact", async () => {
    const result = await relayed({ admit: () => ({ allowed: false, message: "Turn inference budget reached." }) }, { path: "/v1/messages" });
    expect(result.status, "RELAY_BUDGET_REFUSAL").toBe(403);
    expect(JSON.parse(result.body), "RELAY_BUDGET_REFUSAL").toEqual({ type: "error",
      error: { type: "budget_exceeded", message: "Turn inference budget reached." } });
    expect(result.upstream, "BUDGET_REFUSED_BEFORE_CONTACT").toEqual([]);
    expect(result.receipts).toEqual([]);
  });

  test("a request without reported usage is unknown spend, never zero", async () => {
    reply = () => Response.json({ content: [] });
    try {
      const result = await relayed({}, { path: "/v1/messages" });
      expect(result.receipts).toMatchObject([{ outcome: "completed", usage: null }]);
    } finally { reply = () => Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }); }
  });
});

describe("raw usage", () => {
  test("Gemini embeddings split input by modality and keep cached tokens apart", () => {
    expect(providerUsage("gemini", "embeddings", { usageMetadata: { promptTokenCount: 17,
      promptTokenDetails: [{ modality: "TEXT", tokenCount: 12 }, { modality: "IMAGE", tokenCount: 5 }] } }))
      .toEqual({ inputTokens: 17, inputByModality: { TEXT: 12, IMAGE: 5 } });
    expect(providerUsage("gemini", "completions", { usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 4,
      candidatesTokenCount: 3, thoughtsTokenCount: 2 } })).toEqual({ inputTokens: 6, cacheReadTokens: 4, outputTokens: 5 });
  });

  test("malformed or absent usage stays unknown", () => {
    expect(providerUsage("gemini", "embeddings", { embeddings: [] })).toBeNull();
    expect(providerUsage("anthropic", "completions", { usage: { input_tokens: -1, output_tokens: "3" } })).toBeNull();
    expect(providerUsage("openai", "image", null)).toBeNull();
  });
});

describe("BRAIN_UI_CLI_PROVIDER_ORIGINS", () => {
  test("lists exact origins per key", () => {
    expect(parseCliProviderOrigins("GEMINI_API_KEY=https://gateway.ithaca.example; ITHACA_GATEWAY_KEY=https://a.example,http://127.0.0.1:8080"))
      .toEqual(new Map([["GEMINI_API_KEY", ["https://gateway.ithaca.example"]], ["ITHACA_GATEWAY_KEY", ["https://a.example", "http://127.0.0.1:8080"]]]));
    expect(parseCliProviderOrigins(undefined)).toEqual(new Map());
    expect(parseCliProviderOrigins(" ")).toEqual(new Map());
  });

  test.each([
    "GEMINI_API_KEY", "=https://a.example", "GEMINI_API_KEY=", "GEMINI_API_KEY=https://a.example/v1beta",
    "GEMINI_API_KEY=http://gateway.ithaca.example", "GEMINI_API_KEY=https://user@a.example", "1KEY=https://a.example",
  ])("refuses %p", value => { expect(() => parseCliProviderOrigins(value)).toThrow("BRAIN_UI_CLI_PROVIDER_ORIGINS"); });
});

describe("review hardening", () => {
  test("a streamed request is refused before contact, so its usage is never silently unknown", async () => {
    const result = await relayed({}, { path: "/v1/messages", body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: true, messages: [] }) });
    expect(result.upstream, "RELAY_REFUSES_STREAMING").toEqual([]);
    expect(result.status).toBe(403);
    expect(result.refusals, "RELAY_REFUSES_STREAMING").toMatchObject([{ reason: "streaming_not_relayed" }]);
    expect(result.upstream).toEqual([]);
  });

  test("an upstream that echoes the key never hands it to the worker, even split across chunks", async () => {
    reply = () => {
      const half = KEYS.ANTHROPIC_API_KEY!.length >> 1;
      const parts = [`{"echo":"${KEYS.ANTHROPIC_API_KEY!.slice(0, half)}`, `${KEYS.ANTHROPIC_API_KEY!.slice(half)}","usage":{"input_tokens":1,"output_tokens":1}}`];
      const body = new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
      return new Response(body, { headers: { "content-type": "application/json", "x-debug-key": KEYS.ANTHROPIC_API_KEY!, "request-id": "odysseus-1" } });
    };
    try {
      const result = await relayed({}, { path: "/v1/messages" });
      expect(result.status).toBe(200);
      expect(result.body.includes(KEYS.ANTHROPIC_API_KEY!), "RELAY_SCRUBS_ECHOED_KEY").toBe(false);
      expect(JSON.parse(result.body).echo).toBe("[redacted]");
      expect(result.receipts, "SCRUBBED_RESPONSE_STILL_METERED").toMatchObject([{ usage: { inputTokens: 1, outputTokens: 1 } }]);
    } finally { reply = () => Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }); }
  });

  test("an echoed key in a response header is dropped", async () => {
    reply = () => Response.json({ usage: { input_tokens: 1 } }, { headers: { "x-debug-key": KEYS.ANTHROPIC_API_KEY! } });
    try {
      const relay = startProviderRelay({ credential: name => KEYS[name], origins: new Map([["ANTHROPIC_API_KEY", [upstream.url.origin]]]) });
      try {
        const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const outgoing = httpRequest({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages", headers: { "x-brain-provider": "anthropic",
            "x-brain-provider-key": "ANTHROPIC_API_KEY", "x-brain-provider-origin": upstream.url.origin, "content-type": "application/json" } },
          incoming => { incoming.resume(); incoming.on("end", () => resolve(incoming.headers)); });
          outgoing.on("error", reject); outgoing.end("{}");
        });
        expect(headers["x-debug-key"], "RELAY_DROPS_ECHOED_KEY_HEADER").toBeUndefined();
      } finally { await relay.stop(); }
    } finally { reply = () => Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }); }
  });

  test("admission is checked again just before dispatch", async () => {
    let calls = 0;
    const result = await relayed({ admit: () => ++calls === 1 ? { allowed: true } : { allowed: false, message: "Turn inference budget reached." } },
      { path: "/v1/messages" });
    expect(calls, "RELAY_RECHECKS_BUDGET_BEFORE_DISPATCH").toBe(2);
    expect(result.refusals, "RELAY_RECHECKS_BUDGET_BEFORE_DISPATCH").toMatchObject([{ reason: "budget_exceeded" }]);
    expect(result.upstream).toEqual([]);
  });

  test("each attempt reports dispatched before contact, then its outcome", async () => {
    const result = await relayed({}, { path: "/v1/messages" });
    expect(result.dispatched, "RELAY_REPORTS_DISPATCH").toHaveLength(1);
    expect(result.dispatched[0]!.attemptId).toBe(result.receipts[0]!.attemptId);
  });

  test("more concurrent requests than the cap are refused as busy, and stop() waits for in-flight attempts", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    reply = () => new Response(new ReadableStream({ async start(controller) { await gate; controller.enqueue(new TextEncoder().encode('{"usage":{"input_tokens":1}}')); controller.close(); } }),
      { headers: { "content-type": "application/json" } });
    const receipts: ProviderRelayReceipt[] = [];
    const relay = startProviderRelay({ credential: name => KEYS[name], origins: new Map([["ANTHROPIC_API_KEY", [upstream.url.origin]]]),
      observe: receipt => { if (receipt.outcome !== "dispatched") receipts.push(receipt); } });
    const send = () => new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages", headers: { "x-brain-provider": "anthropic",
        "x-brain-provider-key": "ANTHROPIC_API_KEY", "x-brain-provider-origin": upstream.url.origin, "content-type": "application/json" } },
      incoming => { incoming.resume(); incoming.on("end", () => resolve(incoming.statusCode ?? 0)); incoming.on("error", () => resolve(incoming.statusCode ?? 0)); });
      outgoing.on("error", () => resolve(0)); outgoing.end("{}"); void reject;
    });
    try {
      const inflight = Array.from({ length: MAX_PROVIDER_CONCURRENT_REQUESTS }, send);
      // Wait until every slot holds a dispatched attempt.
      for (let tries = 0; seen.length < MAX_PROVIDER_CONCURRENT_REQUESTS && tries < 200; tries++) await Bun.sleep(10);
      expect(await send(), "RELAY_CAPS_CONCURRENT_REQUESTS").toBe(503);
      const stopped = relay.stop();
      await stopped;
      expect(receipts.length, "RELAY_STOP_SETTLES_INFLIGHT").toBe(MAX_PROVIDER_CONCURRENT_REQUESTS);
      expect(receipts.every(receipt => receipt.outcome === "cancelled" && receipt.usage === null)).toBe(true);
      release();
      await Promise.all(inflight);
    } finally { release(); await relay.stop(); reply = () => Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }); seen.length = 0; }
  });
});
