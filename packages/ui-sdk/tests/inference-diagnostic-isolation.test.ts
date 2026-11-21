import { expect, spyOn, test } from "bun:test";
import { request } from "node:http";
import type { EgressRecord, InferenceTimingMark } from "../src/server/egress-proxy";
import { startInferenceRelay } from "../src/server/inference-relay";
import type { InferenceUsage } from "../src/server/inference-usage";
import * as usageObserver from "../src/server/inference-usage";

const points = ["admitMs", "bodyMs", "credentialMs", "dispatchMs", "headersMs", "firstChunkMs", "firstChunkOnce", "usage", "usageFactory", "usageChunk"] as const;
for (const point of points) test(`throwing relay diagnostic ${point} preserves dispatch and bytes`, async () => {
  const inbound = Buffer.from('{"model":"odysseus","stream":true,"text":"Ἰθάκη"}');
  const outbound = Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":17}}}\n\nevent: message_stop\ndata: {}\n\n');
  const marks = new Set<InferenceTimingMark>();
  let firstReadAttempts = 0;
  let capturedUsage: InferenceUsage | undefined, failures = 0, dispatched = 0, received: Buffer | undefined;
  let outcome: EgressRecord["outcome"] | undefined;
  const controller = new AbortController();
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    dispatched++; received = Buffer.from(await req.arrayBuffer());
    return new Response(new ReadableStream<Uint8Array>({ start(output) {
      output.enqueue(outbound.subarray(0, 11)); output.enqueue(outbound.subarray(11)); output.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const observer = point === "usageFactory" || point === "usageChunk" ? spyOn(usageObserver, "inferenceUsageObserver").mockImplementation(() => {
    if (point === "usageFactory") { failures++; throw Error("usage factory unavailable"); }
    return () => { failures++; throw Error("usage observer unavailable"); };
  }) : undefined;
  const relay = startInferenceRelay({ upstream: upstream.url.origin, routes: ["/v1/messages"], credentials: {}, egress: {
    inference() { return {
      async admit() { return true; }, commit() { return true; }, charge() { return true; }, signal: controller.signal,
      outcome() { return outcome; }, reason() { return undefined; }, refusal() { return undefined; },
      finish(value) { outcome = value; },
      mark(name) { if (name === "firstChunkMs") firstReadAttempts++; if (name === point || point === "firstChunkOnce" && name === "firstChunkMs" && failures === 0) { failures++; throw Error("mark unavailable"); } marks.add(name); },
      observeUsage(value) { if (point === "usage") { failures++; throw Error("usage capture unavailable"); } capturedUsage = value; },
    }; },
  } });
  try {
    let response: { status: number; body: Buffer } | undefined, failed: unknown;
    try {
      response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = request({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages", headers: { "content-length": inbound.length } }, res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(Buffer.from(chunk)));
          res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
          res.on("error", reject); res.on("aborted", () => reject(Error("response interrupted")));
        }); req.on("error", reject); req.end(inbound);
      });
    } catch (error) { failed = error; }
    expect(failed, "DIAGNOSTIC_FAILURE_NEVER_INTERRUPTS_RESPONSE").toBeUndefined();
    expect(response?.status, "DIAGNOSTIC_FAILURE_NEVER_CHANGES_REQUEST_STATUS").toBe(200);
    expect(dispatched, "DIAGNOSTIC_FAILURE_NEVER_SKIPS_DISPATCH").toBe(1);
    expect(received, "DIAGNOSTIC_FAILURE_PRESERVES_REQUEST_BYTES").toEqual(inbound);
    expect(response?.body, "DIAGNOSTIC_FAILURE_PRESERVES_RESPONSE_BYTES").toEqual(outbound);
    expect(outcome, "DIAGNOSTIC_FAILURE_NEVER_CHANGES_OUTCOME").toBe("completed"); expect(failures, "THROWING_DIAGNOSTIC_WAS_REACHED").toBeGreaterThan(0);
    if (point.startsWith("usage")) {
      expect(capturedUsage, "FAILED_USAGE_CAPTURE_STAYS_ABSENT").toBeUndefined();
      expect(marks.size).toBe(6);
    } else {
      expect(marks.has(point === "firstChunkOnce" ? "firstChunkMs" : point as InferenceTimingMark), "FAILED_RELAY_MARK_STAYS_ABSENT").toBe(false);
      if (point === "firstChunkOnce") expect(firstReadAttempts, "FIRST_READ_MARK_IS_ATTEMPTED_ONCE").toBe(1);
      expect(marks.size).toBe(5); expect(capturedUsage).toEqual({ inputTokens: 17 });
    }
  } finally { relay.stop(); observer?.mockRestore(); await upstream.stop(true); }
});
