/**
 * The restricted worker's one route out (#676): a real relay socket in front
 * of a loopback fixture upstream. Requests travel over the Unix socket with
 * node:http, as a worker's would; nothing leaves loopback.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { request } from "node:http";
import { ANTHROPIC_INFERENCE_ROUTES, MAX_INFERENCE_REQUEST_BYTES, startInferenceRelay, type InferenceRelay, type InferenceRelayEvent } from "../src/server/inference-relay";

const KEY = "sk-odysseus-server-held";
const seen: Array<{ method: string; path: string; headers: Record<string, string>; body: string }> = [];
const upstream: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req): Promise<Response> {
  const url = new URL(req.url);
  seen.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: await req.text() });
  if (url.pathname === "/v1/messages/count_tokens") return Response.redirect(`http://127.0.0.1:${upstream.port}/elsewhere`, 307);
  return new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream", "set-cookie": "session=odysseus" } });
} });
const relays: InferenceRelay[] = [];
afterEach(() => { for (const relay of relays.splice(0)) relay.stop(); seen.length = 0; });

function relay(observe?: (event: InferenceRelayEvent) => void): InferenceRelay {
  const started = startInferenceRelay({ upstream: `http://127.0.0.1:${upstream.port}`, routes: ANTHROPIC_INFERENCE_ROUTES,
    credentials: { "x-api-key": KEY }, ...(observe ? { observe } : {}) });
  relays.push(started);
  return started;
}

function send(socketPath: string, method: string, path: string, headers: Record<string, string> = {}, body = ""):
  Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, res => {
      let text = "";
      res.setEncoding("utf8").on("data", chunk => { text += chunk; }).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("inference relay", () => {
  test("forwards an inference POST with the server's credential and none of the worker's", async () => {
    const events: InferenceRelayEvent[] = [];
    const r = relay(event => events.push(event));
    const res = await send(r.socketPath, "POST", "/v1/messages?beta=true", { "x-api-key": "worker-placeholder", authorization: "Bearer stolen",
      cookie: "c=1", "x-forwarded-for": "10.0.0.1", "anthropic-version": "2023-06-01", "content-type": "application/json" }, "{\"model\":\"odysseus\"}");
    expect(res.status).toBe(200);
    expect(res.body).toContain("message_stop");
    expect(res.headers["set-cookie"], "upstream cookies stay in the relay").toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/messages?beta=true", body: "{\"model\":\"odysseus\"}" });
    expect(seen[0]!.headers["x-api-key"], "CREDENTIAL_REPLACED").toBe(KEY);
    for (const name of ["authorization", "cookie", "x-forwarded-for"]) expect(seen[0]!.headers[name], name).toBeUndefined();
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(events).toEqual([{ method: "POST", path: "/v1/messages", outcome: "forwarded", status: 200 }]);
  });

  test.each([
    ["GET", "/v1/messages", 405],
    ["POST", "/v1/files", 403],
    ["POST", "/v1/messages/batches", 403],
    ["POST", "/v1/messages/../../v1/files", 403],
    ["POST", "/V1/MESSAGES", 403],
  ])("refuses %s %s without reaching the upstream", async (method, path, status) => {
    const r = relay();
    const res = await send(r.socketPath, method, path, {}, method === "POST" ? "{}" : "");
    expect(res.status).toBe(status);
    expect(JSON.parse(res.body).error.type).toBe("brain_inference_refused");
    expect(seen, "RELAY_REFUSED_BEFORE_UPSTREAM").toEqual([]);
  });

  test("never follows an upstream redirect", async () => {
    const r = relay();
    const res = await send(r.socketPath, "POST", "/v1/messages/count_tokens", {}, "{}");
    expect(res.status, "REDIRECT_REFUSED").toBe(502);
    expect(seen.map(s => s.path)).toEqual(["/v1/messages/count_tokens"]);
  });

  test("refuses an oversized body before forwarding", async () => {
    const r = relay();
    const res = await send(r.socketPath, "POST", "/v1/messages", { "content-length": String(MAX_INFERENCE_REQUEST_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  test("socket and directory are private to the server user and removed on stop", () => {
    const r = relay();
    expect(statSync(r.dir).mode & 0o777).toBe(0o700);
    expect(statSync(r.socketPath).mode & 0o777).toBe(0o600);
    r.stop();
    expect(existsSync(r.dir)).toBe(false);
  });

  test.each([
    ["ftp://127.0.0.1/", "http(s)"],
    ["https://user:secret@api.example/", "must not carry credentials"],
    ["https://api.example/?key=1", "must not carry credentials"],
  ])("refuses upstream %s", (upstreamUrl, message) => {
    expect(() => startInferenceRelay({ upstream: upstreamUrl, routes: ["/v1/messages"], credentials: { "x-api-key": KEY } })).toThrow(message);
  });

  test("refuses a credential header that could split a request", () => {
    expect(() => startInferenceRelay({ upstream: "https://api.example", routes: ["/v1/messages"], credentials: { "x-api-key": "a\r\nx-evil: 1" } }))
      .toThrow("Invalid relay credential header");
  });
});

afterAll(() => { void upstream.stop(true); });
