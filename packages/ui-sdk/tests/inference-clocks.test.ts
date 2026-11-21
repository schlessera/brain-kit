import { expect, spyOn, test } from "bun:test";
import { request } from "node:http";
import { startInferenceRelay } from "../src/server/inference-relay";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy";

test("inference clocks separate body, credentials, dispatch and upstream without changing bytes", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const records: EgressRecord[] = [];
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 100000,
    observe: record => records.push(record), admitted() { admitted(); } });
  let received = "";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    received = await req.text(); now += 200;
    return new Response("Odysseus returns to Ithaca.");
  } });
  const relay = startInferenceRelay({ upstream: upstream.url.origin, routes: ["/v1/messages"], egress: proxy,
    credentials: async () => { now += 120; return { "x-api-key": "odysseus" }; } });
  try {
    const done = new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages", headers: { "content-length": "4" } }, res => {
        let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve(body)); res.on("error", reject);
      });
      req.on("error", reject); req.write("{");
      void admission.then(() => setImmediate(() => { now += 80; req.end("  }"); }));
    });
    expect(await done).toBe("Odysseus returns to Ithaca.");
    expect(received).toBe("{  }");
    expect(records).toHaveLength(1);
    expect(records[0], "INFERENCE_BOUNDARY_CLOCKS").toMatchObject({ admitMs: 0, bodyMs: 80, credentialMs: 200,
      dispatchMs: 200, headersMs: 400, firstChunkMs: 400, durationMs: 400, outcome: "completed" });
    expect(records[0]!.loopLagMaxMs, "DISPATCH_SAMPLES_TIMER_DRIFT_BEFORE_A_DELAYED_CALLBACK").toBe(150);
  } finally { relay.stop(); proxy.stop(); await upstream.stop(true); clock.mockRestore(); }
});

test("failed credentials keep reached clocks and never invent dispatch or header clocks", async () => {
  const records: EgressRecord[] = [];
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 100000, observe: r => records.push(r) });
  const relay = startInferenceRelay({ upstream: "http://127.0.0.1:1", routes: ["/v1/messages"], egress: proxy,
    credentials: async () => { throw Error("unavailable"); } });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages" }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.end("{}");
    });
    expect(status).toBe(499); expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "failed", reason: "inference_credentials_unavailable" });
    expect(typeof records[0]!.bodyMs, "FAILED_REQUEST_RETAINS_BODY_CLOCK").toBe("number");
    expect(records[0]!.dispatchMs).toBeUndefined(); expect(records[0]!.headersMs).toBeUndefined();
  } finally { relay.stop(); proxy.stop(); }
});

test("a known event loop block before dispatch appears in maximum timer drift", async () => {
  const records: EgressRecord[] = [];
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 100000, observe: r => records.push(r) });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("Ithaca"); } });
  const relay = startInferenceRelay({ upstream: upstream.url.origin, routes: ["/v1/messages"], egress: proxy,
    credentials: async () => {
      // Deliberately block callbacks for 120 ms: this is the measured stimulus,
      // not a settling delay or a watchdog. It must exceed the 50 ms sampler.
      const end = performance.now() + 120;
      while (performance.now() < end) { /* simulated synchronous host work */ }
      return {};
    } });
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages" }, res => {
        let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve(body)); res.on("error", reject);
      }); req.on("error", reject); req.end("{}");
    });
    expect(result).toBe("Ithaca"); expect(records).toHaveLength(1);
    expect(records[0]!.loopLagMaxMs!, "EVENT_LOOP_BLOCK_IS_VISIBLE_BEFORE_TIMER_CALLBACK").toBeGreaterThanOrEqual(70);
    expect(records[0]!.dispatchMs!).toBeGreaterThanOrEqual(120);
    expect(records[0]!.loopLagMaxMs!).toBeLessThanOrEqual(records[0]!.durationMs);
  } finally { relay.stop(); proxy.stop(); await upstream.stop(true); }
});

test("a denied first admission records the completed decision before its terminal event", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const records: EgressRecord[] = [];
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: ["ithaca.invalid"], maxBytes: 100000,
    approveOutward: async () => { now += 125; return false; }, observe: record => records.push(record) });
  try {
    const operation = proxy.inference("POST", new URL("https://ithaca.invalid/v1/messages"), new AbortController().signal);
    expect(await operation.admit()).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0], "DENIED_ADMISSION_HAS_ITS_DECISION_CLOCK").toMatchObject({ inference: true, admitMs: 125, durationMs: 125,
      outcome: "denied", reason: "outward_not_approved" });
    expect(records[0]!.dispatchMs).toBeUndefined();
  } finally { proxy.stop(); clock.mockRestore(); }
});

test("cancellation during an unresolved admission emits immediately without inventing its return clock", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const records: EgressRecord[] = [];
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 100000,
    async admitted() { entered.resolve(); await release.promise; }, observe: record => records.push(record) });
  let admitting: Promise<boolean> | undefined;
  try {
    const operation = proxy.inference("POST", new URL("https://ithaca.invalid/v1/messages"), new AbortController().signal);
    admitting = operation.admit(); await entered.promise;
    operation.finish("cancelled", "turn_cancelled");
    expect(records, "CANCELLATION_NEVER_WAITS_FOR_AN_ADMISSION_CLOCK").toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "cancelled", reason: "turn_cancelled" });
    expect(records[0]!.admitMs).toBeUndefined(); release.resolve(); await admitting;
    expect(records).toHaveLength(1); expect(records[0]!.admitMs).toBeUndefined();
  } finally { release.resolve(); await admitting; proxy.stop(); }
});

test("the first admission clock includes its final synchronous commit check", async () => {
  let now = 1000, commits = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now), records: EgressRecord[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("Ithaca"); } });
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 100000,
    committed() { if (++commits === 1) now += 250; }, observe: record => records.push(record) });
  const relay = startInferenceRelay({ upstream: upstream.url.origin, routes: ["/v1/messages"], egress: proxy, credentials: {} });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages" }, res => {
        let result = ""; res.on("data", chunk => { result += chunk; }); res.on("end", () => resolve(result)); res.on("error", reject);
      }); req.on("error", reject); req.end("{}");
    });
    expect(body).toBe("Ithaca");
    expect(records[0], "ADMISSION_CLOCK_INCLUDES_FINAL_COMMIT_CHECK").toMatchObject({ admitMs: 250, bodyMs: 250, dispatchMs: 250 });
    expect(commits, "ADMISSION_CHECKS_ARE_NOT_DUPLICATED").toBe(3);
  } finally { relay.stop(); proxy.stop(); await upstream.stop(true); clock.mockRestore(); }
});
