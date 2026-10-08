import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectReviewEvidence, validateReviewEvidence, saveEvidenceBundle, type RuntimeIdentity } from "../scripts/evals/smart-capture/review-evidence";
import { sha } from "../scripts/evals/smart-capture/admission";
import { AUTHORIZATION_URL, type PaidBinding, type PaidPolicy } from "../scripts/evals/smart-capture/paid-policy";
import { CLEARED_API_CREDENTIALS } from "../packages/core/src/providers/agents/claude-subscription";
import { fixtureSha, protocolSha, sourceHashes } from "../scripts/evals/smart-capture/protocol";
import { admitCurrentReview, native } from "../scripts/evals/smart-capture/live";
import { fixtures } from "../scripts/evals/smart-capture/pipeline";
const model = "claude-sonnet-5-5";
const runtime: RuntimeIdentity = { sdk: "0.3.283", nativeSha: "fixture-native-byte-hash", nativeMode: 0o755, bunSha: "fixture-bun-byte-hash", bunVersion: "1.4.2", bunMode: 0o755 };
/** Synthetic complete format control; never an actual provider approval. No transport runs here. */
function fixture(prompt: string, kind = "offline-native-scripted") {
  const directory = mkdtempSync(join(tmpdir(), "brain-canonical-conflict-review-format-"));
  const usage = { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const account = { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" };
  const settings = { effective: { apiKeyHelper: "", env: { ...CLEARED_API_CREDENTIALS } }, sources: [] };
  const init = { type: "system", subtype: "init", model, permissionMode:"default", apiKeySource: "none", claude_code_version: "2.1.283", tools: [] };
  const rate = { type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false } };
  const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "APPROVED", modelUsage: {
    [model]: { inputTokens: 10, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      costBasis: "unknown", contextWindow: 200000, maxOutputTokens: 32000 } } };
  const output = [ { type: "control_response", response: { request_id: "brain-initialize", subtype: "success", response: { account } } },
    { type: "control_response", response: { request_id: "brain-settings", subtype: "success", response: settings } }, init, rate, result ];
  const startUsage = { ...usage, output_tokens: 0 };
  const response = [ { type: "message_start", message: { model, usage: startUsage } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "APPROVED" } },
    { type: "message_delta", usage: { output_tokens: 7 } }, { type: "message_stop" } ].map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
  const request = JSON.stringify({ model, max_tokens: 1000, output_config: { effort: "low" }, tools: [], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] });
  const call = { authRoute: "subscription-oauth-no-api-key", upstream: "https://api.anthropic.com/v1/messages", requestMethod: "POST", requestPath: "/v1/messages",
    status: 200, requestedModel: model, servedModel: model, outcome: "completed", finished: true, responseClosed: true, responseEof: true, responseCancelled: false,
    rawRequestBase64: Buffer.from(request).toString("base64"), requestSha: sha(request), stateBytes: Buffer.byteLength(request),
    rawResponseBase64: Buffer.from(response).toString("base64"), rawResponseSha: sha(response), responseBytes: Buffer.byteLength(response),
    usage, rawUsageEvents: [{ type: "message_start", usage: startUsage }, { type: "message_delta", usage: { output_tokens: 7 } }],
    apiEquivalent: { lowerUsd: 0.00009, upperUsd: 0.00009, unknownCacheTokens: 0 }, actualInvoiceUsd: null };
  const native = { init, account, settings, rates: [rate], result, failure: null, exitCode: 0, signalCode: null, finished: true,
    drained: true, stdoutComplete: true, stdinComplete: true, stderrDrained: true, promptReleased: true, overage: "inactive observed", additionalBilledUsd: null, apiEquivalent: { lowerUsd: 0.00009, upperUsd: 0.00009, unknownCacheTokens: 0 } };
  const binding: PaidBinding = { fixtureSha: "a".repeat(64), protocolSha: "b".repeat(64), sourceFreezeSha: "c".repeat(64), runtimeSha: sha(JSON.stringify(runtime)), promptSha: sha(prompt), proofSha: "d".repeat(64) };
  const startedAtUtc = "2026-10-08T10:00:00.000Z", finishedAtUtc = "2026-10-08T10:00:01.000Z";
  const policy: PaidPolicy = { ...binding, purpose:"review",grantNonce:"1".repeat(64), consumedMarkerPath:join(directory,`${"1".repeat(64)}.json`), version: 1, issue: 839, authorizationUrl: AUTHORIZATION_URL, allowOverage: true, basis: "actual additional billed charges", perIssueCapUsd: 15, aggregateCapUsd: 150, remainingUpperUsd: 15, issuedAt:startedAtUtc, expiresAt: "2026-10-08T10:01:00.000Z", canonicalModel: model, maxPhysicalRequests: 24, maxInputBytes: 3000000, maxInputTokens: 1000000, contextWindowTokens: 1000000, maxOutputTokens: 128000, inputUsdPerMillionUpper: 8, outputUsdPerMillionUpper: 20, invoiceUsd: null };
  Object.assign(call, {localSessionSha:"7".repeat(64),materializedUserContentSha:sha(JSON.stringify(JSON.parse(request).messages.map((m:any)=>m.content))), startedAtUtc, finishedAtUtc, forwarded:true, forwardedAtUtc:startedAtUtc, requestHeaders: {}, responseHeaders: {}, reservedUpperUsd: (1000000*8+1000*20)/1000000, usageDerivedChargeUpperUsd: .00022, closureTimedOut: false });
  const execution = {localSessionSha:"7".repeat(64), kind, transport: kind==="subscription-native-direct"?"global-fetch":"injected-offline-fetch", upstream: call.upstream, binding, policy, promptSha: sha(prompt), readOnlyReview: true,
    startedAtUtc, finishedAtUtc, runtime, relayClosed: true, runnerFailure: null, additionalBilledUsd: null };
  const grant={version:1,grantNonce:policy.grantNonce,policySha:sha(JSON.stringify(policy)),bindingSha:sha(JSON.stringify(binding)),claimedAtUtc:startedAtUtc,invoiceUsd:null};
  const grantBytes=JSON.stringify(grant); Object.assign(execution,{grantSha:sha(grantBytes)});writeFileSync(join(directory,"grant.json"),grantBytes);
  Object.assign(native,{localSessionSha:"7".repeat(64),grantSha:sha(grantBytes),executionKind:kind,admissionBinding:binding,paidPolicySha:sha(JSON.stringify(policy))});
  for (const [name, value] of Object.entries({ "execution.json": execution, "native.json": native, "physical.json": [call] }))
    writeFileSync(join(directory, name), JSON.stringify(value));
  writeFileSync(join(directory, "native.json.stdout.jsonl"), output.map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(directory, "native.json.stdin.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
  writeFileSync(join(directory, "native.json.stderr.bin"), "");
  const expected = { ...binding, runtime };
  return { directory, expected, evidence: saveEvidenceBundle(directory), native, execution, call, output, close: () => rmSync(directory, { recursive: true, force: true }) };
}


test("complete raw scripted APPROVED control remains semantically ineligible after paid policy and provider metadata", () => {
  const f=fixture("Odysseus complete review packet");
  try { expect(inspectReviewEvidence(f.expected,f.evidence)).toEqual({complete:true,semanticEligible:false}); expect(validateReviewEvidence(f.expected,f.evidence)).toBe(false); expect(validateReviewEvidence(f.expected,undefined)).toBe(false); }
  finally {f.close();}
});
test("raw replay validates policy expiry as of captured dispatch and compares every expected binding", () => {
  const f=fixture("Odysseus complete review packet");
  try {
    expect(Date.parse(f.execution.policy.expiresAt)).toBeLessThan(Date.now());
    expect(inspectReviewEvidence(f.expected,f.evidence).complete).toBe(true);
    for (const key of ["fixtureSha","protocolSha","sourceFreezeSha","runtimeSha","promptSha","proofSha"])
      expect(inspectReviewEvidence({...f.expected,[key]:"e".repeat(64)},f.evidence).complete).toBe(false);
    f.execution.policy.expiresAt=f.execution.startedAtUtc;
    writeFileSync(join(f.directory,"execution.json"),JSON.stringify(f.execution));
    expect(inspectReviewEvidence(f.expected,saveEvidenceBundle(f.directory)).complete).toBe(false);
  } finally {f.close();}
});
test("raw admission reparses literal request/model/usage/EOF and refuses rewritten metadata or private headers", () => {
  const changes = [
    ["execution.json", (f: ReturnType<typeof fixture>) => ({...f.execution, runtime:{...runtime,nativeSha:"different"}})],
    ["native.json", (f: ReturnType<typeof fixture>) => ({...f.native, additionalBilledUsd:0})],
    ["native.json", (f: ReturnType<typeof fixture>) => ({...f.native, stdoutComplete:false})],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{...f.call,responseEof:false}]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{...f.call,closureTimedOut:true}]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{...f.call,actualInvoiceUsd:0}]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{...f.call,usage:{...f.call.usage,cache_read_input_tokens:null}}]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{...f.call,requestHeaders:{authorization:"fixture-credential"}}]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{...f.call,rawRequestBase64:Buffer.from("different request").toString("base64")}]],
    ["native.json.stdin.jsonl", () => JSON.stringify({type:"user",message:{content:"different prompt"}})],
  ] as const;
  for(const [name,change] of changes){const f=fixture("Odysseus complete review packet");try {const value=change(f);writeFileSync(join(f.directory,name),typeof value==="string"?value:JSON.stringify(value));expect(inspectReviewEvidence(f.expected,saveEvidenceBundle(f.directory)).complete).toBe(false);}finally{f.close();}}
  const f=fixture("Odysseus complete review packet");try {writeFileSync(join(f.directory,"native.json.stderr.bin"),"changed after capture");expect(readFileSync(join(f.directory,"native.json.stderr.bin"),"utf8")).not.toBe("");expect(inspectReviewEvidence(f.expected,f.evidence).complete).toBe(false);}finally{f.close();}
});
test("live native refuses an injected transport before any actual dispatch",async()=>{
  let dispatched=0;
  await expect(native(fixtures[0]!,"/unused","/unused","review","offline-fixture",undefined,"Odysseus", "f".repeat(64),undefined,{offline:true,policy:{} as PaidPolicy,fetch:async()=>{dispatched++;return new Response("unused");}})).rejects.toThrow("protected networkless");
  expect(dispatched).toBe(0);
});

test("raw admission refuses missing native rate evidence and contradictory physical paid headers",()=>{
 for(const missing of [true,false]){const f=fixture("Odysseus complete review packet");try{
  if(missing){f.native.rates=[];writeFileSync(join(f.directory,"native.json"),JSON.stringify(f.native));writeFileSync(join(f.directory,"native.json.stdout.jsonl"),f.output.filter(e=>e.type!=="rate_limit_event").map(e=>JSON.stringify(e)).join("\n"));}
  else{Object.assign(f.call,{responseHeaders:{"anthropic-ratelimit-unified-status":"rejected","anthropic-ratelimit-unified-overage-status":"rejected"}});writeFileSync(join(f.directory,"physical.json"),JSON.stringify([f.call]));}
  expect(inspectReviewEvidence(f.expected,saveEvidenceBundle(f.directory)).complete).toBe(false);
 }finally{f.close();}}
});

test("scoring admission recomputes actual current source/runtime rather than trusting a current-labelled wrapper",()=>{
 const f=fixture("Odysseus complete review packet","subscription-native-direct");
 try{
  expect(validateReviewEvidence(f.expected,f.evidence)).toBe(true); // Synthetic format only, not collected provider approval.
  const wrapper={approved:true,model,fixtureSha,protocolSha,sourceHashes,binding:f.expected,runtime:f.expected.runtime,promptSha:f.expected.promptSha,proofSha:f.expected.proofSha,evidence:f.evidence};
  expect(admitCurrentReview(wrapper)).toBe(false); // Actual current-byte runtime/source differ despite wrapper's current flags.
 }finally{f.close();}
});


test("short wire raw admission refuses a byte-derived financial hold despite complete native evidence",()=>{
 const f=fixture("Odysseus complete review packet");
 try{expect(inspectReviewEvidence(f.expected,f.evidence).complete).toBe(true);
  const bytes=Buffer.from(f.call.rawRequestBase64,"base64");const request=JSON.parse(bytes.toString());
  const oldHold={...f.call,reservedUpperUsd:(bytes.length*8+request.max_tokens*20)/1000000};
  expect(oldHold.reservedUpperUsd).toBeLessThan(8);
  writeFileSync(join(f.directory,"physical.json"),JSON.stringify([oldHold]));
  expect(inspectReviewEvidence(f.expected,saveEvidenceBundle(f.directory)).complete).toBe(false);
 }finally{f.close();}
});
