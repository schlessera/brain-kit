/** Private collected artifacts, independently reparsed before semantic admission. */
import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assertPaidPolicy, overageAllowed, type PaidBinding, type PaidPolicy } from "./paid-policy";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
import { settingsRefusal, subscriptionRefusal, CLEARED_API_CREDENTIALS } from "../../../packages/core/src/providers/agents/claude-subscription";
import { NONSECRET_HEADERS } from "./relay";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";

const MODEL = "claude-sonnet-5-5";
export interface RuntimeIdentity { sdk: string; nativeSha: string; nativeMode: number; bunSha: string; bunVersion: string; bunMode: number }
export interface ExecutionEvidence {
  kind: "offline-native-scripted" | "subscription-native-direct";
  transport: "injected-offline-fetch" | "global-fetch"; upstream: string;
  binding: PaidBinding; policy: PaidPolicy | null; promptSha: string; readOnlyReview: boolean; runtime: RuntimeIdentity;
  startedAtUtc: string; finishedAtUtc: string | null; localSessionSha: string; grantSha: string; relayClosed: boolean; runnerFailure: string | null; additionalBilledUsd: null;
}
export interface EvidenceReference { directory: string; manifestSha: string }
const members = ["execution.json", "grant.json", "native.json", "native.json.stdin.jsonl", "native.json.stdout.jsonl", "native.json.stderr.bin", "physical.json"] as const;
export function saveEvidenceBundle(directory: string): EvidenceReference {
  const hashes = Object.fromEntries(members.map(name => [name, sha(readFileSync(join(directory, name)))]));
  const bytes = JSON.stringify({ version: 1, hashes }, null, 2);
  writeFileSync(join(directory, "review-evidence.json"), bytes, { mode: 0o600 });
  return { directory, manifestSha: sha(bytes) };
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
function jsonLines(bytes: Buffer): any[] {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n").filter(s => s.trim()).map(s => JSON.parse(s));
}
function sse(bytes: Buffer): any[] {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n").split("\n\n").flatMap(frame => {
    const data = frame.split("\n").filter(s => s.startsWith("data: ")).map(s => s.slice(6)).join("\n");
    return !data || data === "[DONE]" ? [] : [JSON.parse(data)];
  });
}
/** This checks collected artifacts, not an invoice or cryptographic proof against a dishonest artifact owner. */
const INVALID = { complete: false, semanticEligible: false };
export function inspectReviewEvidence(expected: PaidBinding & { runtime: RuntimeIdentity }, ref: EvidenceReference | undefined) {
  try {
    if (!ref || !lstatSync(ref.directory).isDirectory() || lstatSync(ref.directory).isSymbolicLink()) return INVALID;
    const bytes = readFileSync(join(ref.directory, "review-evidence.json"));
    if (sha(bytes) !== ref.manifestSha) return INVALID;
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.version !== 1 || !equal(Object.keys(manifest.hashes), members)) return INVALID;
    const raw = Object.fromEntries(members.map(name => {
      const path = join(ref.directory, name);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error("Evidence must be literal regular files");
      const data = readFileSync(path); if (sha(data) !== manifest.hashes[name]) throw Error("Changed collected evidence");
      return [name, data];
    }));
    const execution: ExecutionEvidence = JSON.parse(raw["execution.json"]!.toString("utf8"));
    // Offline controls stay ineligible even if their APPROVED text and old metadata are relabelled.
    const semanticEligible = execution.kind === "subscription-native-direct" && execution.transport === "global-fetch";
    if (execution.upstream !== "https://api.anthropic.com/v1/messages" || !execution.readOnlyReview || !execution.relayClosed ||
      execution.runnerFailure !== null || execution.additionalBilledUsd !== null || !equal(execution.binding, { fixtureSha: expected.fixtureSha, protocolSha: expected.protocolSha, sourceFreezeSha: expected.sourceFreezeSha, runtimeSha: expected.runtimeSha, promptSha: expected.promptSha, proofSha: expected.proofSha }) ||
      execution.promptSha !== expected.promptSha || !equal(execution.runtime, expected.runtime) || expected.runtime.sdk !== "0.3.283" || expected.runtime.bunVersion !== "1.4.2") return INVALID;
    if (!execution.policy || execution.policy.purpose!=="review" || !/^[a-f0-9]{64}$/.test(execution.localSessionSha)) return INVALID;
    const started = Date.parse(execution.startedAtUtc), finished = Date.parse(execution.finishedAtUtc ?? "");
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return INVALID;
    assertPaidPolicy(execution.policy, expected, started);
    const grant=JSON.parse(raw["grant.json"]!.toString("utf8"));
    const claim=Date.parse(grant.claimedAtUtc);
    if(sha(raw["grant.json"]!)!==execution.grantSha || grant.version!==1 || grant.grantNonce!==execution.policy.grantNonce || grant.policySha!==sha(JSON.stringify(execution.policy)) || grant.bindingSha!==sha(JSON.stringify(execution.binding)) || grant.invoiceUsd!==null || !Number.isFinite(claim) || claim<started || claim>finished)return INVALID;
    assertPaidPolicy(execution.policy,expected,claim);
    const native = JSON.parse(raw["native.json"]!.toString("utf8"));
    if (native.localSessionSha!==execution.localSessionSha || native.grantSha !== execution.grantSha || native.executionKind !== execution.kind || !equal(native.admissionBinding, execution.binding) || native.paidPolicySha !== sha(JSON.stringify(execution.policy))) return INVALID;
    if (native.failure || native.inputFailure || native.stderrFailure || native.termination || native.exitCode !== 0 || native.signalCode !== null ||
      !native.finished || !native.drained || !native.stdoutComplete || !native.stdinComplete || !native.stderrDrained || !native.promptReleased || native.additionalBilledUsd !== null) return INVALID;
    const input = jsonLines(raw["native.json.stdin.jsonl"]!);
    const users = input.filter(e => e.type === "user");
    if (users.length !== 1 || typeof users[0].message?.content !== "string" || sha(users[0].message.content) !== expected.promptSha) return INVALID;
    const output = jsonLines(raw["native.json.stdout.jsonl"]!);
    const init = output.filter(e => e.type === "system" && e.subtype === "init"), results = output.filter(e => e.type === "result");
    const account = output.filter(e => e.type === "control_response" && e.response?.request_id === "brain-initialize");
    const settings = output.filter(e => e.type === "control_response" && e.response?.request_id === "brain-settings");
    if (init.length !== 1 || results.length !== 1 || account.length !== 1 || settings.length !== 1 ||
      account[0].response.subtype !== "success" || settings[0].response.subtype !== "success" ||
      subscriptionRefusal(account[0].response.response?.account) || settingsRefusal(settings[0].response.response)) return INVALID;
    const reportedAccount = account[0].response.response.account, reportedSettings = settings[0].response.response;
    if (reportedAccount.apiProvider !== "firstParty" || !["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"].includes(reportedAccount.tokenSource) ||
      reportedSettings.effective?.apiKeyHelper !== "" || !reportedSettings.effective?.env ||
      Object.keys(CLEARED_API_CREDENTIALS).some(key => reportedSettings.effective.env[key] !== "")) return INVALID;
    if (!equal(native.init, init[0]) || !equal(native.account, account[0].response.response.account) || !equal(native.settings, settings[0].response.response) ||
      init[0].permissionMode !== "default" || init[0].model !== MODEL || init[0].apiKeySource !== "none" || init[0].claude_code_version !== "2.1.283" || !equal(init[0].tools, [])) return INVALID;
    const rates = output.filter(e => e.type === "rate_limit_event");
    if (!rates.length || !equal(native.rates, rates) || rates.some(r => !overageAllowed(r.rate_limit_info, true))) return INVALID;
    const result = results[0];
    if (!equal(native.result, result) || result.is_error !== false || result.subtype !== "success" || result.num_turns !== 1 ||
      typeof result.result !== "string" || !/^APPROVED(?:\s|$)/.test(result.result.trim()) ||
      !equal(Object.keys(result.modelUsage ?? {}), [MODEL]) || !equal(native.apiEquivalent, priceSonnet55Usage(result))) return INVALID;
    const usage = result.modelUsage[MODEL];
    // CLI283 fallback context/cost metadata stays historical; capacity comes from the root primary-source policy.
    const calls = JSON.parse(raw["physical.json"]!.toString("utf8"));
    if (!Array.isArray(calls) || !calls.length || calls.length > 24) return INVALID;
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    let physicalText = "", retainedUpperUsd = 0;
    for (const call of calls) {
      if (call.localSessionSha!==execution.localSessionSha || call.forwarded !== true || call.authRoute !== "subscription-oauth-no-api-key" || call.upstream !== "https://api.anthropic.com/v1/messages" || call.requestMethod !== "POST" || call.requestPath !== "/v1/messages" || call.status !== 200 || call.requestedModel !== MODEL || call.servedModel !== MODEL || call.outcome !== "completed" || call.failure || call.closureTimedOut ||
        !call.finished || !call.responseClosed || !call.responseEof || call.responseCancelled || call.actualInvoiceUsd !== null) return INVALID;
      const headerStatus=call.responseHeaders?.["anthropic-ratelimit-unified-status"], headerOverage=call.responseHeaders?.["anthropic-ratelimit-unified-overage-status"];
      if(headerStatus!==undefined || headerOverage!==undefined){
        const fromHeaders={status:headerStatus??"allowed",overageStatus:headerOverage,isUsingOverage:headerStatus==="rejected" && ["allowed","allowed_warning"].includes(headerOverage),overageInUse:call.responseHeaders?.["anthropic-ratelimit-unified-overage-in-use"]==="true",overageDisabledReason:call.responseHeaders?.["anthropic-ratelimit-unified-overage-disabled-reason"]};
        if(!overageAllowed(fromHeaders,true) || !rates.some(r=>r.rate_limit_info?.status===(headerStatus==="allowed_warning"?"allowed":headerStatus??"allowed") && r.rate_limit_info?.isUsingOverage===fromHeaders.isUsingOverage && (headerOverage===undefined || r.rate_limit_info?.overageStatus===headerOverage)))return INVALID;
      }
      const requestBytes = Buffer.from(call.rawRequestBase64, "base64"), responseBytes = Buffer.from(call.rawResponseBase64, "base64");
      if (sha(requestBytes) !== call.requestSha || requestBytes.length !== call.stateBytes || sha(responseBytes) !== call.rawResponseSha || responseBytes.length !== call.responseBytes) return INVALID;
      const dispatched = Date.parse(call.forwardedAtUtc ?? ""), closed = Date.parse(call.finishedAtUtc ?? "");
      if (!Number.isFinite(dispatched) || !Number.isFinite(closed) || dispatched < claim || closed < dispatched || closed > finished) return INVALID;
      assertPaidPolicy(execution.policy, expected, dispatched);
      if (Object.keys(call.requestHeaders ?? {}).some(key => !NONSECRET_HEADERS.includes(key)) || Object.keys(call.responseHeaders ?? {}).some(key => !NONSECRET_HEADERS.includes(key)) || /fast|priority|regional/i.test(call.requestHeaders?.["anthropic-beta"] ?? "")) return INVALID;
      const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes));
      if ((request.speed !== undefined && request.speed !== "standard") || (request.service_tier !== undefined && !["standard_only","auto"].includes(request.service_tier)) || (request.inference_geo !== undefined && !["global","us"].includes(request.inference_geo)) || request.fast_mode || request.region || request.priority) return INVALID;
      if (request.model !== MODEL || !integer(request.max_tokens) || request.max_tokens < 1 || request.max_tokens > execution.policy.maxOutputTokens || !Array.isArray(request.messages) || request.tools?.length || request.output_config?.effort !== "low") return INVALID;
      const texts = request.messages.filter((m: any) => m.role === "user").flatMap((m: any) => typeof m.content === "string" ? [m.content] :
        Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text) : []);
      if(call.materializedUserContentSha!==sha(JSON.stringify(request.messages.filter((m:any)=>m.role==="user").map((m:any)=>m.content))))return INVALID;
      if (texts.filter((s: unknown) => typeof s === "string" && sha(s) === expected.promptSha).length!==1) return INVALID;
      const events = sse(responseBytes), starts = events.filter(e => e.type === "message_start"), stops = events.filter(e => e.type === "message_stop");
      if (starts.length !== 1 || stops.length !== 1 || starts[0].message?.model !== MODEL || events.some(e => e.type === "error" || e.content_block?.type === "tool_use")) return INVALID;
      let counters: Record<string, any> = {}, sawFinal = false;
      const rawUsageEvents: unknown[] = [];
      for (const event of events) {
        const u = event.type === "message_start" ? event.message?.usage : event.type === "message_delta" ? event.usage : null;
        if (u) { rawUsageEvents.push({ type: event.type, usage: u }); counters = { ...counters, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v != null)) }; }
        if (event.type === "message_delta" && integer(event.usage?.output_tokens)) sawFinal = true;
        if (event.type === "content_block_start" && event.content_block?.type === "text") physicalText += event.content_block.text ?? "";
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") physicalText += event.delta.text;
      }
      if (!sawFinal || !equal(counters, call.usage) || !equal(rawUsageEvents, call.rawUsageEvents)) return INVALID;
      for (const [physical, nativeKey] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["cache_read_input_tokens", "cacheReadInputTokens"], ["cache_creation_input_tokens", "cacheCreationInputTokens"]] as const) {
        if (!integer(counters[physical])) return INVALID;
        totals[nativeKey] += counters[physical];
      }
      const priced = priceSonnet55Usage({ modelUsage: { [MODEL]: { inputTokens: counters.input_tokens, outputTokens: counters.output_tokens,
        cacheReadInputTokens: counters.cache_read_input_tokens, cacheCreationInputTokens: counters.cache_creation_input_tokens } }, usage: { cache_creation: counters.cache_creation } });
      const factor=request.inference_geo==="us"?1.1:1;
      if (!equal({...priced,lowerUsd:priced.lowerUsd*factor,upperUsd:priced.upperUsd*factor}, call.apiEquivalent)) return INVALID;
      const input = counters.input_tokens + counters.cache_read_input_tokens + counters.cache_creation_input_tokens;
      const usageUpper = (input * 8 + counters.output_tokens * 20) / 1000000;
      const inputTokenCeiling = Math.min(execution.policy.maxInputTokens, execution.policy.contextWindowTokens);
      const reserved = (inputTokenCeiling * 8 + request.max_tokens * 20) / 1000000;
      if (retainedUpperUsd + reserved > execution.policy.remainingUpperUsd || requestBytes.length > execution.policy.maxInputBytes || input > inputTokenCeiling || counters.output_tokens > request.max_tokens || usageUpper > reserved || call.reservedUpperUsd !== reserved || call.usageDerivedChargeUpperUsd !== usageUpper) return INVALID;
      retainedUpperUsd += usageUpper;
    }
    if (retainedUpperUsd > execution.policy.remainingUpperUsd) return INVALID;
    return physicalText.trim() === result.result.trim() && Object.entries(totals).every(([key, n]) => usage[key] === n) ? { complete: true, semanticEligible } : INVALID;
  } catch { return INVALID; }
}

export function validateReviewEvidence(expected: PaidBinding & { runtime: RuntimeIdentity }, ref: EvidenceReference | undefined): boolean {
  const proof = inspectReviewEvidence(expected, ref); return proof.complete && proof.semanticEligible;
}
