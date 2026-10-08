/** Exact physical Codex Responses request/SSE receipts; no credentials are written. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { createPiSchemaReplay } from "./pi-schema-replay.ts";
import { toolInputJsonSchema, SHOW_BLOCK_DESCRIPTION } from "@schlessera/brain-ui-sdk/server";
import { measurementSchema, nativeCredential, PI_SCHEMA_REQUEST_LIMIT, PI_SCHEMA_MODEL, PI_SCHEMA_PROMPT } from "./pi-schema-measurement.ts";

/** Decode a COPY of the installed provider's body, forward the original bytes. */
export function decodePiRequest(body: unknown, headers: Headers) {
  const wire = typeof body === "string" ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body) : null;
  if (!wire) throw new Error("Unknown Codex request body encoding.");
  const encoding = headers.get("content-encoding");
  if (encoding && encoding !== "zstd") throw new Error("Unexpected Codex request compression.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(encoding === "zstd" ? zstdDecompressSync(wire) : wire);
  return { body: JSON.parse(text), wireSha256: createHash("sha256").update(wire).digest("hex"), encoding: encoding ?? "identity" };
}
const captureDrains:Promise<void>[]=[];
export async function waitPiSchemaCaptures(){await Promise.all(captureDrains);}
const counter = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Upstream CreditsSnapshot exposes balance, not paid-use attribution. */
export function observeCodexBilling(snapshot: {headers?:Record<string,string>;event?:any}, statePath: string) {
  const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,"utf8")):{balance:null,stop:null,snapshots:[]};
  if(state.stop) return state.stop as string;
  const headers=snapshot.headers??{},event=snapshot.event;
  const rawBalance=headers["x-codex-credits-balance"]??event?.credits?.balance;
  const balance=typeof rawBalance==="string"&&rawBalance.trim()!==""&&Number.isFinite(Number(rawBalance))&&Number(rawBalance)>=0?Number(rawBalance):null;
  const reached=headers["x-codex-rate-limit-reached-type"]??event?.rate_limit_reached_type;
  const reachedTypes=new Set(["rate_limit_reached","workspace_owner_credits_depleted","workspace_member_credits_depleted","workspace_owner_usage_limit_reached","workspace_member_usage_limit_reached"]);
  const windows=Object.entries(headers).filter(([name])=>/^x-codex(?:-[a-z-]+)?-(primary|secondary)-used-percent$/.test(name)).map(([,value])=>Number(value));
  for(const window of [event?.rate_limits?.primary,event?.rate_limits?.secondary]) if(window?.used_percent!==undefined)windows.push(window.used_percent);
  const errorCode=event?.error?.code??event?.response?.error?.code;
  let stop:string|null=null;
  if(reachedTypes.has(reached)||windows.some(value=>typeof value==="number"&&Number.isFinite(value)&&value>=100))stop="Included-only unresolved: provider reports an exhausted included limit.";
  if(balance!==null&&state.balance!==null&&balance<state.balance)stop="Included-only unresolved: credit balance decreased; no charge attribution is inferred.";
  if(errorCode==="usage_not_included"||errorCode==="usage_limit_reached")stop="Included-only unresolved: provider rejects included usage.";
  state.snapshots.push(snapshot);if(balance!==null)state.balance=balance;state.stop=stop;
  writeFileSync(statePath,JSON.stringify(state,null,2),{mode:0o600});return stop;
}
export function validateTerminalUsage(usage: any) {
  if (!usage || !counter(usage.input_tokens) || !counter(usage.output_tokens) || !counter(usage.total_tokens) || usage.total_tokens !== usage.input_tokens + usage.output_tokens || !counter(usage.input_tokens_details?.cached_tokens) || usage.input_tokens_details.cached_tokens > usage.input_tokens || !counter(usage.output_tokens_details?.reasoning_tokens) || usage.output_tokens_details.reasoning_tokens > usage.output_tokens) throw new Error("Codex terminal usage is unknown.");
}

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface PiSchemaReceipt {
  sequence: number;
  requestedModel: string;
  form: string;
  route: "native-codex-subscription";
  auth: { bearerMatchesNativeAccess: boolean; accountHeaderMatchesNativeClaim: boolean; originator: string | null };
  request: unknown;
  wireSha256: string;
  encoding: string;
  showBlockSchemaSha256: string;
  status: number | null;
  headers: Record<string, string>;
  terminal: boolean;
  eof: boolean;
  servedModel: string | null;
  usage: unknown;
  functionCalls: unknown[];
  error: string | null;
  streamLifecycle?:Array<{event:string;afterTerminal:boolean}>;
  provenance?: {kind:"recovered-original-physical";originalReceiptSha256:string;rawSha256:string;originalObserverError:string|null;localReplayWireSha256:string;differingFields:string[];unchangedRequestWire:boolean;sameServerSession:boolean;originalHeadersComplete:boolean};
}

export function validatePiSchemaRequest(body: unknown, model: string, expectedParameters: Record<string, unknown>) {
  const request = body as { model?: unknown; input?: Array<{role?:unknown;content?:Array<{type?:unknown;text?:unknown}>}>; tools?: Array<{ type?: unknown; name?: unknown; strict?: unknown; description?: unknown; parameters?: unknown }> };
  if (request?.model !== model || !Array.isArray(request.tools)) throw new Error("Exact request model/tools mismatch.");
  const users = request.input?.filter(row=>row.role==="user");
  if (!users || users.length!==1 || users[0]!.content?.length!==1 || users[0]!.content![0]!.type!=="input_text" || users[0]!.content![0]!.text!==PI_SCHEMA_PROMPT) throw new Error("Actual Codex input differs from the reviewed frozen prompt.");
  const tools = request.tools.filter(tool => tool.name === "show_block");
  if (tools.length !== 1 || tools[0]!.type !== "function" || tools[0]!.strict !== null || tools[0]!.description !== SHOW_BLOCK_DESCRIPTION || digest(tools[0]!.parameters) !== digest(expectedParameters)) {
    throw new Error("Actual serialized show_block form differs from frozen non-strict parameters.");
  }
}

export function assertPiSchemaAcceptance(record: { completed: boolean; errors: string[]; escapedBrain: boolean; showBlockCalls: Array<{ok: boolean}> }, receipts: PiSchemaReceipt[], form: string) {
  if (!record.completed || record.errors.length || record.escapedBrain || !record.showBlockCalls.some(call => call.ok)) throw new Error("Provider acceptance requires successful turn AND an accepted parsed show_block call.");
  if (!receipts.length || receipts.length > PI_SCHEMA_REQUEST_LIMIT || receipts.some((row, index) => row.sequence !== index + 1 || row.form !== form || row.requestedModel !== PI_SCHEMA_MODEL || row.servedModel !== PI_SCHEMA_MODEL || row.route !== "native-codex-subscription" || !row.auth.bearerMatchesNativeAccess || !row.auth.accountHeaderMatchesNativeClaim || row.auth.originator !== "pi" || row.status !== 200 || !row.terminal || !row.eof || row.error)) throw new Error("Physical Codex acceptance evidence is incomplete.");
  for (const receipt of receipts) validateTerminalUsage(receipt.usage);
}

export function installPiSchemaCapture(delegate: typeof fetch = globalThis.fetch.bind(globalThis)) {
  const credential = nativeCredential();
  const model = process.env.BRAIN_MEASURE_CODEX_MODEL;
  const form = process.env.BRAIN_MEASURE_PI_SCHEMA_FORM;
  const out = process.env.BRAIN_MEASURE_PI_RECEIPTS;
  if (model !== PI_SCHEMA_MODEL || !form || !out) throw new Error("Missing bounded Codex capture configuration or ruled model.");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const receipts: PiSchemaReceipt[] = [];
  const billingState=process.env.BRAIN_MEASURE_PI_BILLING_STATE??join(out,"billing-state.json");
  const save = () => writeFileSync(join(out, "physical-requests.json"), JSON.stringify(receipts, null, 2), { mode: 0o600 });
  const parameters = toolInputJsonSchema(measurementSchema(form));
  const replayRoot=process.env.BRAIN_MEASURE_PI_REPLAY_ROOT;
  if(replayRoot&&form!=="flat")throw new Error("Only original flat prefix can be rehydrated.");
  const replay=replayRoot?createPiSchemaReplay(replayRoot,{receiptSha256:process.env.BRAIN_MEASURE_PI_REPLAY_RECEIPT_SHA!,rawSha256:process.env.BRAIN_MEASURE_PI_REPLAY_RAW_SHA!},join(out,"replay-events.jsonl")):null;
  const capture = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return delegate(input, init);
    await waitPiSchemaCaptures();
    if(receipts.some(receipt=>receipt.error||!receipt.eof))throw new Error("Prior physical stream receipt is incomplete; no next request.");
    if(existsSync(billingState)&&JSON.parse(readFileSync(billingState,"utf8")).stop)throw new Error("Known included-only stop forbids another physical request.");
    if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/codex/responses" || url.search || init?.method !== "POST") {
      throw new Error("Measurement denies an unapproved provider/discovery/auth-refresh route.");
    }
    if (receipts.length >= PI_SCHEMA_REQUEST_LIMIT) throw new Error("Physical request bound reached; no automatic rerun.");
    const headers = new Headers(init.headers);
    const auth = { bearerMatchesNativeAccess: headers.get("authorization") === `Bearer ${credential.access}`, accountHeaderMatchesNativeClaim: headers.get("chatgpt-account-id") === credential.accountId, originator: headers.get("originator") };
    if (!auth.bearerMatchesNativeAccess || !auth.accountHeaderMatchesNativeClaim || auth.originator !== "pi" || headers.has("x-api-key")) throw new Error("Actual Codex subscription headers mismatch.");
    const { body, wireSha256, encoding } = decodePiRequest(init.body, headers);
    validatePiSchemaRequest(body, model, parameters);
    const prefix=replay?.beforeRequest(body,wireSha256);
    const receipt: PiSchemaReceipt = { sequence: receipts.length + 1, requestedModel: model, form, route: "native-codex-subscription", auth, request: body, wireSha256, encoding, showBlockSchemaSha256: digest(parameters), status: null, headers: {}, terminal: false, eof: false, servedModel: null, usage: null, functionCalls: [], error: null };
    if(prefix){receipt.request=prefix.original.request;receipt.wireSha256=prefix.original.wireSha256;receipt.encoding=prefix.original.encoding;receipt.auth=prefix.original.auth;receipt.provenance=prefix.provenance;}
    receipts.push(receipt); save();
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(init.signal ? [init.signal] : [])]);
      const response = prefix?.response??await delegate(input, { ...init, signal, redirect: "error" });
      receipt.status = response.status;
      for (const [name, value] of response.headers) if (/^(content-type$|content-encoding$|x-request-id|x-ratelimit-|x-codex-|retry-after)/i.test(name)) receipt.headers[name] = value;
      observeCodexBilling({headers:receipt.headers},billingState);
      save();
      // Match installed Pi transport: parse a successful body regardless of media type.
      // Terminal SSE/model/usage/EOF guards establish acceptance; headers remain evidence.
      if (response.status !== 200 || !response.body) {
        const raw=new Uint8Array(await response.arrayBuffer());writeFileSync(join(out, `physical-${receipt.sequence}.error-body`), raw, { mode: 0o600 });
        const text=new TextDecoder().decode(raw); // decoded copy only; original bytes precede JSON interpretation
        try{observeCodexBilling({event:JSON.parse(text)},billingState);}catch{};
        throw new Error("Codex request failed or returned no response body.");
      }
      const rawPath = join(out, `physical-${receipt.sequence}.sse`);
      writeFileSync(rawPath, "", { mode: 0o600 });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const observeLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        const event = JSON.parse(data);
        if(event.type==="codex.rate_limits"||["response.failed","response.incomplete","error"].includes(event.type))observeCodexBilling({event},billingState);
        if (event.type === "response.output_item.done" && event.item?.type === "function_call") receipt.functionCalls.push(event.item);
        if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
          receipt.servedModel = typeof event.response?.model === "string" ? event.response.model : null;
          receipt.usage = event.response?.usage ?? null; save();
          throw new Error("Codex terminal failure/incomplete response.");
        }
        if (event.type === "response.completed") {
          receipt.servedModel = typeof event.response?.model === "string" ? event.response.model : null;
          receipt.usage = event.response?.usage ?? null; save();
          if (receipt.terminal || event.response?.status !== "completed" || event.response?.model !== model) throw new Error("Codex terminal status/model mismatch.");
          const usage = event.response.usage;
          validateTerminalUsage(usage);
          receipt.terminal = true; receipt.servedModel = event.response.model; receipt.usage = usage; save();
        }
      };
      const consume = (text: string, eof = false) => {
        pending += text;
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) { observeLine(pending.slice(0, newline).replace(/\r$/, "")); pending = pending.slice(newline + 1); }
        if (eof && pending) { observeLine(pending.replace(/\r$/, "")); pending = ""; }
      };
      let consumerClosed=false,upstreamCancelled=false;
      let resolveDrain!:()=>void;
      const drain=new Promise<void>(resolve=>{resolveDrain=resolve;});captureDrains.push(drain);
      const lifecycle=(event:string)=>{(receipt.streamLifecycle??=[]).push({event,afterTerminal:receipt.terminal});save();};
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller){
          void(async()=>{
            try{
              while(true){
                const next=await reader.read();
                if(next.done){
                  if(upstreamCancelled)throw new Error("Upstream cancelled; natural EOF remains unknown.");
                  receipt.eof=true;lifecycle("natural-upstream-eof");
                  consume(decoder.decode(),true);
                  if(!receipt.terminal)throw new Error("Codex EOF before completed response.");
                  if(!consumerClosed){consumerClosed=true;controller.close();}
                  break;
                }
                appendFileSync(rawPath,next.value); // literal received bytes precede consumer parsing
                consume(decoder.decode(next.value,{stream:true}));
                if(!consumerClosed)controller.enqueue(next.value);
              }
            }catch(error){
              receipt.error??=error instanceof Error?error.message:"Unknown stream error";
              lifecycle("observer-error");
              if(!consumerClosed){consumerClosed=true;controller.error(error);}
              upstreamCancelled=true;await reader.cancel().catch(()=>{});
            }finally{resolveDrain();}
          })();
        },
        async cancel(reason){
          consumerClosed=true;lifecycle("consumer-cancelled");
          // Pi returns after the completed terminal frame. Continue independent observation
          // through natural provider EOF; cancelling its consumer is not an upstream EOF.
          if(!receipt.terminal){
            receipt.error??="Consumer cancelled before completed terminal; upstream EOF unknown.";
            upstreamCancelled=true;save();await reader.cancel(reason).catch(()=>{});
          }
        }
      });
      return new Response(bodyStream, { status: response.status, headers: response.headers });
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : "Unknown request error"; save(); throw error;
    }
  }) as typeof fetch;
  globalThis.fetch = capture;
  return { receipts, restore() { globalThis.fetch = delegate; } };
}
