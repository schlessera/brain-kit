/** Private extraction review relay: actual native OAuth requests, same first-party API. */
import { createHash } from "node:crypto";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
import {observedNativeModifiers,type NativeBudget} from "../native-paid-policy";
import {rejectResponseModifiers} from "../native-pricing";
export const MODEL = "claude-sonnet-5-5";
export interface NativeCall {
  upstreamReaderClosed:boolean;upstreamDispatched:boolean;requestPricingHeaders:Record<string,string>;responseHeaders:Record<string,string>;
  authRoute: "subscription-oauth-no-api-key"|"refused"; upstream: string; requestMethod: string; requestPath: string;
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
  save: (calls: NativeCall[]) => void; upstream?: string;budget?:NativeBudget;verifyPaid?:()=>void;onRefusal?:(reason:string)=>void;
}) {
  const calls: NativeCall[] = [];
  let stopped = false;
  const active = new Map<NativeCall, { abort: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null; done: Promise<void> }>();
  const upstream = new URL(options.upstream ?? "https://api.anthropic.com");
  if (upstream.origin !== "https://api.anthropic.com" && !["127.0.0.1", "localhost"].includes(upstream.hostname)) throw Error("Unapproved upstream");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const requestBytes = new Uint8Array(await request.arrayBuffer()),started=performance.now();
    const authenticated=request.headers.get("authorization")===`Bearer ${options.oauthToken}`&&!request.headers.get("x-api-key");
    let json:any=null,parseFailure:unknown=null;try{json=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(requestBytes));}catch(error){parseFailure=error;}
    const call:NativeCall={upstreamReaderClosed:false,upstreamDispatched:false,requestPricingHeaders:Object.fromEntries([...request.headers].filter(([name])=>name==="anthropic-beta")),responseHeaders:{},authRoute:authenticated?"subscription-oauth-no-api-key":"refused",upstream:`${upstream.origin}${url.pathname}${url.search}`,requestMethod:request.method,requestPath:`${url.pathname}${url.search}`,
      requestSha:createHash("sha256").update(requestBytes).digest("hex"),stateBytes:requestBytes.byteLength,requestedModel:json?.model??"unknown",servedModel:null,status:null,usage:null,finished:false,outcome:"received",durationMs:0,apiEquivalent:null,rawUsageEvents:[],rawRequestBase64:Buffer.from(requestBytes).toString("base64"),rawResponseBase64:"",rawResponseSha:createHash("sha256").update(new Uint8Array()).digest("hex"),responseBytes:0,responseEof:false,responseCancelled:false,responseClosed:false,actualInvoiceUsd:null};
    calls.push(call); options.save(calls);
    const reject=(status:number,outcome:string,error?:unknown)=>{stopped=true;call.status=status;call.outcome=outcome;call.failure=error==null?outcome:String(error);call.finished=true;call.responseClosed=true;call.durationMs=performance.now()-started;options.save(calls);options.onRefusal?.(call.failure);return new Response(outcome,{status});};
    if(stopped||calls.length>24||calls.slice(0,-1).some(c=>c.finished&&c.outcome!=="completed"))return reject(409,"admission_stopped");
    if(request.method!=="POST"||!["/v1/messages","/v1/messages?beta=true"].includes(call.requestPath))return reject(403,"unsupported_native_endpoint");
    if(!authenticated)return reject(403,"subscription_header_refused");
    if(parseFailure)return reject(400,"invalid_native_request",parseFailure);
    if(json.model!==MODEL)return reject(403,"unexpected_requested_model");
    let reservation:number|undefined;
    try{options.verifyPaid?.();if(options.budget)reservation=options.budget.reserve(requestBytes,request.headers);}catch(error){return reject(403,"root_paid_reservation_refused",error);}

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
      if(reservation!==undefined){const id=reservation;reservation=undefined;
        if(call.outcome==="completed"&&call.status===200&&call.responseEof&&!call.responseCancelled&&call.usage){try{options.budget!.settle(id,call.usage as any);}catch(error){stopped=true;call.outcome="root_paid_usage_refused";call.failure=String(error);call.apiEquivalent=null;}}
        else options.budget!.unknown(id);
      }
      call.responseClosed = true; call.finished = true; call.durationMs = performance.now() - started;
      options.save(calls); active.delete(call); resolveDone();if(call.outcome!=="completed")options.onRefusal?.(call.failure??call.outcome);
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
      call.upstreamDispatched=true;options.save(calls);response = await options.fetch(`${upstream.origin}${url.pathname}${url.search}`, { method: "POST", headers, body: requestBytes, redirect: "error", signal: abort.signal });
    } catch (error) {
      failed("network_error", error); request.signal.removeEventListener("abort", onAbort); closed();
      return new Response(String(error), { status: 502 });
    }
    call.status = response.status;call.responseHeaders=Object.fromEntries([...response.headers].filter(([name,value])=>!name.toLowerCase().includes(options.oauthToken.toLowerCase())&&!value.includes(options.oauthToken)));options.save(calls);
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
      finally { request.signal.removeEventListener("abort", onAbort); try{await state.reader.closed;}catch{}call.upstreamReaderClosed=true;state.reader.releaseLock(); closed(); }
      return new Response(Buffer.from(call.rawResponseBase64, "base64"), { status: response.status, headers: outgoing });
    }
    const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", sawStop = false, sawFinalOutput = false;
    function observe(frame: string) {
      const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      if (["message_start", "message_delta"].includes(event.type)) {
        const usage = event.type === "message_start" ? event.message?.usage : event.usage;
        if (usage){call.rawUsageEvents.push({ type: event.type, usage: structuredClone(usage) });if(options.budget)rejectResponseModifiers(usage);}
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
          let parseFailure: unknown = null;try{if(options.budget)observedNativeModifiers(call.responseHeaders);}catch(error){parseFailure=error;stopped=true;}
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
          request.signal.removeEventListener("abort", onAbort); try{await state.reader!.closed;}catch{}call.upstreamReaderClosed=true;state.reader!.releaseLock(); closed();
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
    complete: () => calls.length > 0 && calls.every(c => c.finished && c.upstreamReaderClosed && c.responseClosed && c.responseEof && !c.responseCancelled && c.outcome === "completed" && c.apiEquivalent),
  };
}
