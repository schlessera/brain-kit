import { expect, test } from "bun:test";
import { request } from "node:http";
import { inferenceUsageObserver, type InferenceUsage } from "../src/server/inference-usage";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy";
import { startInferenceRelay } from "../src/server/inference-relay";

const start = (usage: unknown) => `event: message_start\r\ndata: ${JSON.stringify({ type: "message_start", message: { usage } })}\r\n\r\n`;
for (const [name, first, expected] of [
  ["reported", start({ input_tokens: 17, cache_read_input_tokens: 19, cache_creation_input_tokens: 23 }), { inputTokens: 17, cacheReadTokens: 19, cacheCreationTokens: 23 }],
  ["nullable cache usage", start({ input_tokens: 17, cache_read_input_tokens: null, cache_creation_input_tokens: null }), { inputTokens: 17 }],
  ["bare CR line endings", start({ input_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 }).replaceAll("\r\n", "\r"), { inputTokens: 7, cacheReadTokens: 11, cacheCreationTokens: 13 }],
  ["mismatched error frame", "event: message_start\ndata: " + JSON.stringify({ type: "error", message: { usage: { input_tokens: 7 } } }) + "\n\n", {}],
  ["late start after content", "event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n" + start({ input_tokens: 7 }), {}],
  ["malformed usage", start({ input_tokens: "17", cache_read_input_tokens: 19, cache_creation_input_tokens: 23 }), {}],
  ["malformed JSON", "event: message_start\ndata: {unreadable}\n\n", {}],
  ["missing", "event: ping\ndata: {}\n\n", {}],
  ["over the bounded prefix", ":" + "x".repeat(65536) + "\n\n" + start({ input_tokens: 17 }), {}],
] as const) test(`initial provider usage is ${name} while relay bytes stay identical`, async () => {
  const records: EgressRecord[] = [];
  const body = Buffer.from(first + "event: content_block_delta\ndata: {\"text\":\"Ἰθάκη\"}\n\nevent: message_stop\ndata: {}\n\n");
  const inbound = Buffer.from('{"model":"odysseus","stream":true}');
  let received = Buffer.alloc(0);
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    received = Buffer.from(await req.arrayBuffer());
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === body.length) { controller.close(); return; }
      const end = Math.min(body.length, offset + 37); controller.enqueue(body.subarray(offset, end)); offset = end;
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 1000000, observe: record => records.push(record) });
  const relay = startInferenceRelay({ upstream: upstream.url.origin, routes: ["/v1/messages"], credentials: {}, egress: proxy });
  try {
    const output = await new Promise<Buffer>((resolve, reject) => {
      const req = request({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages" }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks))); response.on("error", reject);
      }); req.on("error", reject); req.end(inbound);
    });
    expect(output, "USAGE_INSPECTION_NEVER_REWRITES_RESPONSE_BYTES").toEqual(body);
    expect(received).toEqual(inbound); expect(records).toHaveLength(1);
    expect({ ...(records[0]!.inputTokens !== undefined ? { inputTokens: records[0]!.inputTokens } : {}),
      ...(records[0]!.cacheReadTokens !== undefined ? { cacheReadTokens: records[0]!.cacheReadTokens } : {}),
      ...(records[0]!.cacheCreationTokens !== undefined ? { cacheCreationTokens: records[0]!.cacheCreationTokens } : {}) }, "PER_REQUEST_PROVIDER_USAGE").toEqual(expected);
  } finally { relay.stop(); proxy.stop(); await upstream.stop(true); }
});

test("usage parsing is deferred, chunk-bounded and ignores later usage updates", async () => {
  const records: InferenceUsage[] = [];
  const observe = inferenceUsageObserver(value => records.push(value));
  const bytes = Buffer.from(start({ input_tokens: 0, cache_read_input_tokens: 9, cache_creation_input_tokens: 0 }));
  const original = Buffer.from(bytes);
  observe(bytes.subarray(0, 19)); observe(bytes.subarray(19));
  expect(records, "NO_PARSE_ON_THE_FORWARDING_STACK").toEqual([]);
  await Promise.resolve();
  expect(records).toEqual([{ inputTokens: 0, cacheReadTokens: 9, cacheCreationTokens: 0 }]);
  observe(Buffer.from(start({ input_tokens: 99, cache_read_input_tokens: 99, cache_creation_input_tokens: 99 })));
  await Promise.resolve();
  expect(records).toEqual([{ inputTokens: 0, cacheReadTokens: 9, cacheCreationTokens: 0 }]); expect(bytes).toEqual(original);
});

test("a waiting stream reader receives its chunk before usage inspection runs", async () => {
  const order: string[] = [];
  const bytes = Buffer.from(start({ input_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 }));
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
  const reader = stream.getReader();
  const observe = inferenceUsageObserver(() => { order.push("usage"); });
  try {
    const read = reader.read().then(result => { order.push("forwarded"); expect(result.value).toEqual(bytes); });
    output.enqueue(bytes); observe(bytes); output.close();
    await read; await Promise.resolve();
    expect(order, "FORWARDING_PRECEDES_USAGE_INSPECTION").toEqual(["forwarded", "usage"]);
  } finally { reader.releaseLock(); }
});

for (const ending of ["\n", "\r\n", "\r"]) test(`usage supports every split of SSE ending ${JSON.stringify(ending)}`, async () => {
  const records: InferenceUsage[] = [], observe = inferenceUsageObserver(value => records.push(value));
  const text = start({ input_tokens: 7 }).replaceAll("\r\n", ending);
  for (const byte of Buffer.from(text)) observe(Uint8Array.of(byte));
  await Promise.resolve();
  expect(records, "ALL_SSE_LINE_ENDINGS_ACROSS_CHUNKS").toEqual([{ inputTokens: 7 }]);
});
