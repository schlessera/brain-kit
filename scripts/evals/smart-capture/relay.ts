/** Loopback measurement relay: actual native OAuth requests, same first-party API. */
import { createHash } from "node:crypto";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
export const MODEL = "claude-sonnet-5-5";
export interface NativeCall {
  requestSha: string; stateBytes: number; requestedModel: string; servedModel: string | null;
  status: number | null; usage: Record<string, any> | null; finished: boolean;
  outcome: string; durationMs: number; apiEquivalent: ReturnType<typeof priceSonnet55Usage> | null;
}
export function startRelay(options: {
  oauthToken: string; fetch: (url: string, init: RequestInit) => Promise<Response>;
  save: (calls: NativeCall[]) => void; upstream?: string;
}) {
  const calls: NativeCall[] = [];
  let stopped = false;
  const upstream = new URL(options.upstream ?? "https://api.anthropic.com");
  if (upstream.origin !== "https://api.anthropic.com" && !["127.0.0.1", "localhost"].includes(upstream.hostname)) throw Error("Unapproved upstream");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/messages") return new Response("Measurement permits only the native Messages endpoint", { status: 403 });
    if (stopped || calls.length >= 24 || calls.some(c => c.finished && c.outcome !== "completed")) return new Response("Prior failed physical request or turn request bound", { status: 409 });
    if (request.headers.get("authorization") !== `Bearer ${options.oauthToken}` || request.headers.get("x-api-key")) {
      stopped = true; return new Response("Subscription OAuth required", { status: 403 });
    }
    const body = await request.text();
    const json = JSON.parse(body);
    if (json.model !== MODEL) { stopped = true; return new Response("Unexpected model", { status: 403 }); }
    const started = performance.now();
    const call: NativeCall = { requestSha: createHash("sha256").update(body).digest("hex"), stateBytes: Buffer.byteLength(body), requestedModel: json.model,
      servedModel: null, status: null, usage: null, finished: false, outcome: "started", durationMs: 0, apiEquivalent: null };
    calls.push(call); options.save(calls);
    const headers = new Headers(request.headers);
    for (const field of ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"]) headers.delete(field);
    let response: Response;
    try {
      response = await options.fetch(`${upstream.origin}${url.pathname}${url.search}`, { method: "POST", headers, body, redirect: "error", signal: request.signal });
    } catch (error) {
      call.outcome = "network_error"; call.finished = true; call.durationMs = performance.now() - started;
      stopped = true; options.save(calls); return new Response(String(error), { status: 502 });
    }
    call.status = response.status;
    const outgoing = new Headers(response.headers);
    for (const field of ["content-length", "content-encoding", "transfer-encoding", "connection"]) outgoing.delete(field);
    if (!response.ok || !response.body) {
      call.outcome = "http_error"; call.finished = true; call.durationMs = performance.now() - started;
      stopped = true; options.save(calls); return new Response(response.body, { status: response.status, headers: outgoing });
    }
    const decoder = new TextDecoder(); let buffer = "", sawStop = false;
    function observe(frame: string) {
      const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      if (event.type === "message_start") { call.servedModel = event.message.model; call.usage = { ...event.message.usage }; }
      if (event.type === "message_delta" && event.usage) call.usage = { ...call.usage, ...event.usage };
      if (event.type === "message_stop") sawStop = true;
      if (event.type === "error") { call.outcome = "stream_error"; stopped = true; }
    }
    function drain() {
      buffer = buffer.replace(/\r\n/g, "\n");
      for (;;) {
        const end = buffer.indexOf("\n\n"); if (end < 0) break;
        observe(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      }
    }
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try { buffer += decoder.decode(chunk, { stream: true }); drain(); controller.enqueue(chunk); }
        catch (error) { stopped = true; call.outcome = "parse_error"; call.finished = true; options.save(calls); controller.error(error); }
      },
      flush(controller) {
        try {
          buffer += decoder.decode(); drain(); if (buffer.trim()) observe(buffer);
          if (!sawStop || call.servedModel !== MODEL || !call.usage || call.outcome === "stream_error") throw Error("Incomplete/unexpected native message response");
          call.apiEquivalent = priceSonnet55Usage({ modelUsage: { [MODEL]: {
            inputTokens: call.usage.input_tokens, outputTokens: call.usage.output_tokens,
            cacheReadInputTokens: call.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: call.usage.cache_creation_input_tokens ?? 0,
          } }, usage: { cache_creation: call.usage.cache_creation } });
          call.outcome = "completed";
        } catch (error) { stopped = true; call.outcome = "missing_usage"; controller.error(error); }
        finally { call.finished = true; call.durationMs = performance.now() - started; options.save(calls); }
      },
    }));
    return new Response(stream, { status: response.status, headers: outgoing });
  } });
  return { url: `http://127.0.0.1:${server.port}`, calls,
    stop: () => { stopped = true; server.stop(true); },
    complete: () => calls.length > 0 && calls.every(c => c.finished && c.outcome === "completed" && c.apiEquivalent),
  };
}
