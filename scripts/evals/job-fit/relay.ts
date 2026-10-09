/** Loopback measurement relay: actual native OAuth requests, same first-party API. */
import { createHash } from "node:crypto";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
export const MODEL = "claude-sonnet-5-5";
export interface NativeCall {
  authRoute: "subscription-oauth-no-api-key"; upstream: string; requestMethod: "POST"; requestPath: "/v1/messages";
  requestSha: string; stateBytes: number; requestedModel: string; servedModel: string | null;
  status: number | null; usage: Record<string, any> | null; finished: boolean;
  outcome: string; durationMs: number; apiEquivalent: ReturnType<typeof priceSonnet55Usage> | null;
  // Private byte receipts: never publish request content, credentials or account fields.
  rawRequestBase64: string; rawResponseBase64: string; rawResponseSha: string;
  responseBytes: number; responseEof: boolean; responseCancelled: boolean;
  responseClosed: boolean; actualInvoiceUsd: null;
  failure?: string; rawUsageEvents: Array<{ type: string; usage: Record<string, unknown> }>;
}
export function startRelay(options: {
  oauthToken: string; fetch: (url: string, init: RequestInit) => Promise<Response>;
  save: (calls: NativeCall[]) => void; upstream?: string;
  /** Physical requests one native run may make; a tool-using run needs more than a one-turn review. */
  requestBound?: number;
}) {
  const calls: NativeCall[] = [];
  const requestBound = options.requestBound ?? 24;
  let stopped = false;
  const active = new Map<NativeCall, { abort: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null; done: Promise<void> }>();
  const upstream = new URL(options.upstream ?? "https://api.anthropic.com");
  if (upstream.origin !== "https://api.anthropic.com" && !["127.0.0.1", "localhost"].includes(upstream.hostname)) throw Error("Unapproved upstream");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/messages") return new Response("Measurement permits only the native Messages endpoint", { status: 403 });
    if (stopped || calls.length >= requestBound || calls.some(c => c.finished && c.outcome !== "completed")) return new Response("Prior failed physical request or turn request bound", { status: 409 });
    if (request.headers.get("authorization") !== `Bearer ${options.oauthToken}` || request.headers.get("x-api-key")) {
      stopped = true; return new Response("Subscription OAuth required", { status: 403 });
    }
    const requestBytes = new Uint8Array(await request.arrayBuffer());
    const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes));
    if (json.model !== MODEL) { stopped = true; return new Response("Unexpected model", { status: 403 }); }
    const started = performance.now();
    const call: NativeCall = { authRoute: "subscription-oauth-no-api-key", upstream: `${upstream.origin}${url.pathname}`, requestMethod: "POST", requestPath: "/v1/messages", requestSha: createHash("sha256").update(requestBytes).digest("hex"), stateBytes: requestBytes.byteLength, requestedModel: json.model,
      servedModel: null, status: null, usage: null, finished: false, outcome: "started", durationMs: 0, apiEquivalent: null, rawUsageEvents: [],
      rawRequestBase64: Buffer.from(requestBytes).toString("base64"), rawResponseBase64: "", rawResponseSha: createHash("sha256").update(new Uint8Array()).digest("hex"),
      responseBytes: 0, responseEof: false, responseCancelled: false, responseClosed: false, actualInvoiceUsd: null };
    calls.push(call); options.save(calls);
    const headers = new Headers(request.headers);
    for (const field of ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"]) headers.delete(field);
    const abort = new AbortController();
    let resolveDone!: () => void;
    const state = { abort, reader: null as ReadableStreamDefaultReader<Uint8Array> | null, done: new Promise<void>(resolve => { resolveDone = resolve; }) };
    active.set(call, state);
    const parts: Uint8Array[] = [];
    function capture(chunk: Uint8Array) {
      parts.push(chunk.slice());
      const bytes = Buffer.concat(parts);
      call.rawResponseBase64 = bytes.toString("base64");
      call.rawResponseSha = createHash("sha256").update(bytes).digest("hex");
      call.responseBytes = bytes.byteLength;
      options.save(calls); // Raw bytes persist before any decoder or forwarding.
    }
    function closed() {
      call.responseClosed = true; call.finished = true; call.durationMs = performance.now() - started;
      options.save(calls); active.delete(call); resolveDone();
    }
    function failed(outcome: string, error: unknown) {
      stopped = true; call.outcome = outcome; call.failure = String(error);
    }
    async function cancel(reason: unknown) {
      call.responseCancelled = true; failed("cancelled", reason); abort.abort(reason);
      if (state.reader) await state.reader.cancel(reason);
    }
    const onAbort = () => { void cancel(request.signal.reason ?? "Downstream request aborted").catch(error => { call.failure = String(error); }); };
    request.signal.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await options.fetch(`${upstream.origin}${url.pathname}${url.search}`, { method: "POST", headers, body: requestBytes, redirect: "error", signal: abort.signal });
    } catch (error) {
      failed("network_error", error); request.signal.removeEventListener("abort", onAbort); closed();
      return new Response(String(error), { status: 502 });
    }
    call.status = response.status;
    const outgoing = new Headers(response.headers);
    for (const field of ["content-length", "content-encoding", "transfer-encoding", "connection"]) outgoing.delete(field);
    if (!response.body) {
      failed("missing_body", "Physical response body absent"); call.responseEof = true;
      request.signal.removeEventListener("abort", onAbort); closed();
      return new Response(null, { status: response.status, headers: outgoing });
    }
    state.reader = response.body.getReader();
    if (!response.ok) {
      try {
        for (;;) { const next = await state.reader.read(); if (next.done) { call.responseEof = true; break; } capture(next.value); }
        if (!call.responseCancelled) failed("http_error", `Physical HTTP ${response.status}`);
      } catch (error) { failed("response_error", error); }
      finally { request.signal.removeEventListener("abort", onAbort); state.reader.releaseLock(); closed(); }
      return new Response(Buffer.from(call.rawResponseBase64, "base64"), { status: response.status, headers: outgoing });
    }
    const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", sawStop = false, sawFinalOutput = false;
    function observe(frame: string) {
      const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      if (["message_start", "message_delta"].includes(event.type)) {
        const usage = event.type === "message_start" ? event.message?.usage : event.usage;
        if (usage) call.rawUsageEvents.push({ type: event.type, usage: structuredClone(usage) });
      }
      if (event.type === "message_start") { call.servedModel = event.message.model; call.usage = { ...event.message.usage }; }
      if (event.type === "message_delta" && event.usage) {
        // SDK MessageStream overwrites cumulative counters only when non-null.
        // Preserve raw nullable deltas separately; they do not erase known counts.
        call.usage = { ...call.usage, ...Object.fromEntries(Object.entries(event.usage).filter(([, value]) => value != null)) };
        sawFinalOutput = Number.isSafeInteger(event.usage.output_tokens) && event.usage.output_tokens >= 0;
      }
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
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let parseFailure: unknown = null;
          for (;;) {
            const next = await state.reader!.read();
            if (next.done) { if (!call.responseCancelled) call.responseEof = true; break; }
            capture(next.value);
            if (parseFailure === null) {
              try { buffer += decoder.decode(next.value, { stream: true }); drain(); controller.enqueue(next.value); }
              catch (error) { parseFailure = error; stopped = true; }
            }
            // Even malformed/binary payloads drain into the literal private receipt.
            // Downstream cancellation or owned shutdown still records a partial close.
          }
          if (call.responseCancelled) throw Error("Physical stream cancelled before EOF");
          if (parseFailure !== null) throw parseFailure;
          buffer += decoder.decode(); drain(); if (buffer.trim()) observe(buffer);
          if (!sawStop || !sawFinalOutput || call.servedModel !== MODEL || !call.usage || call.outcome === "stream_error") throw Error("Incomplete/unexpected native message response");
          // Missing aggregate cache counters stay unknown; the pricing helper must refuse.
          call.apiEquivalent = priceSonnet55Usage({ modelUsage: { [MODEL]: {
            inputTokens: call.usage.input_tokens, outputTokens: call.usage.output_tokens,
            cacheReadInputTokens: call.usage.cache_read_input_tokens,
            cacheCreationInputTokens: call.usage.cache_creation_input_tokens,
          } }, usage: { cache_creation: call.usage.cache_creation } });
          call.outcome = "completed"; controller.close();
        } catch (error) {
          if (!call.responseCancelled) failed(call.responseEof ? "missing_usage" : "parse_or_response_error", error);
          await state.reader!.cancel(error).catch(() => {});
          try { controller.error(error); } catch { /* Already cancelled downstream. */ }
        } finally {
          request.signal.removeEventListener("abort", onAbort); state.reader!.releaseLock(); closed();
        }
      },
      async cancel(reason) { await cancel(reason); await state.done; },
    });
    return new Response(stream, { status: response.status, headers: outgoing });
  } });
  return { url: `http://127.0.0.1:${server.port}`, calls,
    stop: async () => {
      stopped = true;
      const pending = [...active.entries()];
      for (const [call, state] of pending) {
        call.responseCancelled = true; call.outcome = "shutdown"; call.failure = "Owned relay shutdown before physical EOF";
        state.abort.abort("Owned relay shutdown");
        if (state.reader) await state.reader.cancel("Owned relay shutdown").catch(() => {});
      }
      server.stop(true);
      await Promise.all(pending.map(([, state]) => state.done));
    },
    complete: () => calls.length > 0 && calls.every(c => c.finished && c.responseClosed && c.responseEof && !c.responseCancelled && c.outcome === "completed" && c.apiEquivalent),
  };
}
