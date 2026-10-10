import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitExactPackets, type ReviewReceipt } from "../scripts/evals/speaking-lifecycle/review-packet";
import { saveEvidenceBundle, type RuntimeIdentity } from "../scripts/evals/speaking-lifecycle/review-evidence";
import { sha } from "../scripts/evals/speaking-lifecycle/freeze";
import { CLEARED_API_CREDENTIALS } from "../packages/core/src/providers/agents/claude-subscription";
import {NativeBudget,PAID_AUTHORIZATION,type NativePaidPolicy} from "../scripts/evals/native-paid-policy";
import {consumeGrant} from "../scripts/evals/native-grant";
import {type ReviewBinding} from "../scripts/evals/native-pricing";
import { runNative } from "../scripts/evals/speaking-lifecycle/native";

const model = "claude-sonnet-5-5";
const runtime: RuntimeIdentity = { sdk: "0.3.293", nativeSha: "fixture-native-byte-hash", nativeMode: 0o755, bunSha: "fixture-bun-byte-hash", bunVersion: "1.4.2", bunMode: 0o755 };
/** Synthetic complete format control; never an actual provider approval. No transport runs here. */
function fixture(prompt: string, kind = "subscription-native-direct") {
  const directory = mkdtempSync(join(tmpdir(), "brain-speaking-lifecycle-review-format-"));
  const usage = { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const account = { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" };
  const settings = { effective: { apiKeyHelper: "", env: { ...CLEARED_API_CREDENTIALS } }, sources: [] };
  const init = { type: "system", subtype: "init", model, apiKeySource: "none", claude_code_version: "2.1.293", tools: [] };
  const rate = { type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false } };
  const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "APPROVED", modelUsage: {
    [model]: { inputTokens: 10, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      canonicalModel: model, provider: "firstParty", costBasis: "list", contextWindow: 1_000_000, maxOutputTokens: 128_000 } } };
  const output = [ { type: "control_response", response: { request_id: "brain-initialize", subtype: "success", response: { account } } },
    { type: "control_response", response: { request_id: "brain-settings", subtype: "success", response: settings } }, init, rate, result ];
  const startUsage = { ...usage, output_tokens: 0 };
  const response = [ { type: "message_start", message: { model, usage: startUsage } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "APPROVED" } },
    { type: "message_delta", usage: { output_tokens: 7 } }, { type: "message_stop" } ].map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
  const request = JSON.stringify({ model, max_tokens:8000, output_config: { effort: "low" }, tools: [], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] });
  const call = { forwarded:true,authRoute: "subscription-oauth-no-api-key", upstream: "https://api.anthropic.com/v1/messages", requestMethod: "POST", requestPath: "/v1/messages",
    upstreamDispatched:true,upstreamReaderClosed:true,requestPricingHeaders:{},responseHeaders:{},status: 200, requestedModel: model, servedModel: model, outcome: "completed", finished: true, responseClosed: true, responseEof: true, responseCancelled: false,
    rawRequestBase64: Buffer.from(request).toString("base64"), requestSha: sha(request), stateBytes: Buffer.byteLength(request),
    rawResponseBase64: Buffer.from(response).toString("base64"), rawResponseSha: sha(response), responseBytes: Buffer.byteLength(response),
    usage, rawUsageEvents: [{ type: "message_start", usage: startUsage }, { type: "message_delta", usage: { output_tokens: 7 } }],
    apiEquivalent: { lowerUsd: 0.00009, upperUsd: 0.00009, unknownCacheTokens: 0 }, actualInvoiceUsd: null };
  const native = { init, account, settings, rates: [rate], result, failure: null, exitCode: 0, signalCode: null, finished: true,
    drained: true, stdoutComplete: true, stderrDrained: true, promptReleased: true, overage: "inactive observed", additionalBilledUsd: null, apiEquivalent: { lowerUsd: 0.00009, upperUsd: 0.00009, unknownCacheTokens: 0 } };
  const execution = { kind, transport: "global-fetch", upstream: call.upstream, freezeSha: sha("same-freeze"), promptSha: sha(prompt), readOnlyReview: true,
    runtime, relayClosed: true, runnerFailure: null, additionalBilledUsd: null };
  const binding:ReviewBinding={freezeSha:execution.freezeSha,inputSha:sha("format inputs"),protocolSha:sha("format protocol"),runtimeSha:sha(JSON.stringify(runtime)),proofSha:sha("format proof"),promptSha:sha(prompt)};
  const now=Date.now(),grantNonce=sha(directory);
  const policy:NativePaidPolicy={...binding,version:1,issue:846,control:kind==="offline-native-scripted"?"offline":"live",purpose:"review",authorizationUrl:PAID_AUTHORIZATION,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,canonicalModel:model,maxPhysicalRequests:24,maxInputBytes:5_000_000,contextWindowTokens:1_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null,grantNonce,consumedMarkerPath:join(directory,grantNonce+".json"),issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
  const grant=consumeGrant(policy,binding,now),budget=new NativeBudget(846,policy.control,policy,binding,()=>{},()=>now);
  const index=budget.reserve(Buffer.from(request));budget.settle(index,usage);
  Object.assign(execution,{paidBinding:binding,paidPolicySha:sha(JSON.stringify(policy))});
  const paid={policy,policySha:sha(JSON.stringify(policy)),binding,startedAtUtc:new Date(now).toISOString(),grant,entries:budget.entries};
  writeFileSync(join(directory,"paid.json"),JSON.stringify(paid),{mode:0o600});
  writeFileSync(join(directory,"paid-grant.json"),readFileSync(policy.consumedMarkerPath),{mode:0o600});
  for (const [name, value] of Object.entries({ "execution.json": execution, "native.json": native, "physical.json": [call] }))
    writeFileSync(join(directory, name), JSON.stringify(value));
  writeFileSync(join(directory, "native.json.stdout.jsonl"), output.map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(directory, "native.json.stdin.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
  writeFileSync(join(directory, "native.json.stderr.bin"), "");
  const expected = { key: "cases-1", freezeSha: sha("same-freeze"), promptSha: sha(prompt), runtime,binding };
  const receipt: ReviewReceipt = { ...expected, approved: true, model, actualCli: "2.1.293", finished: true, drained: true,
    stdoutComplete: true, callsComplete: true, overage: "inactive observed", actualProvider: true, scope: "complementary-semantic-review",
    authorFamily: "gpt", reviewerFamily: "claude", evidence: saveEvidenceBundle(directory) };
  return { directory, expected, receipt, native, execution, call, output, paid,close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("flag-only APPROVED metadata cannot stand in for complete actually collected review artifacts", () => {
  const f = fixture("Odysseus complete review packet");
  try {
    expect(admitExactPackets([f.expected], [f.receipt])).toBe(true); // Format control only.
    expect(admitExactPackets([f.expected], [{ ...f.receipt, evidence: undefined }])).toBe(false);
    expect(admitExactPackets([f.expected], [{ ...f.receipt, promptSha: sha("older payload") }])).toBe(false);
    expect(admitExactPackets([f.expected], [f.receipt, f.receipt])).toBe(false);
    for (const change of [{ approved: false }, { drained: false }, { stdoutComplete: false }, { callsComplete: false }, { overage: "active" },
      { actualProvider: false }, { scope: "offline-control" }, { authorFamily: "claude" }, { reviewerFamily: "gpt" }, { actualCli: "2.1.283" }])
      expect(admitExactPackets([f.expected], [{ ...f.receipt, ...change }])).toBe(false);
  } finally { f.close(); }
});

test("otherwise complete scripted APPROVED artifacts remain inadmissible even with relabelled provider flags", () => {
  // Only the collected execution kind differs; intended mutation fails on this admission assertion.
  const f = fixture("Odysseus complete review packet", "offline-native-scripted");
  try { expect(admitExactPackets([f.expected], [f.receipt])).toBe(false); } finally { f.close(); }
});

test("review admission independently reparses literal prompt/auth/model/usage/error/EOF and runtime evidence", () => {
  const changes = [
    ["execution.json", (f: ReturnType<typeof fixture>) => ({ ...f.execution, runtime: { ...runtime, nativeSha: "different native" } })],
    ["native.json", (f: ReturnType<typeof fixture>) => ({ ...f.native, exitCode: 1 })],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{ ...f.call, responseEof: false }]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{ ...f.call, upstreamReaderClosed: false }]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{ ...f.call, responseHeaders: {"anthropic-service-tier":"priority"} }]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{ ...f.call, usage: { ...f.call.usage, cache_read_input_tokens: null } }]],
    ["physical.json", (f: ReturnType<typeof fixture>) => [{ ...f.call, rawRequestBase64: Buffer.from("different literal request").toString("base64") }]],
    ["native.json.stdout.jsonl", (f: ReturnType<typeof fixture>) => f.output.map(e => JSON.stringify(e.type === "control_response" && "response" in e && e.response?.request_id === "brain-initialize" ?
      { ...e, response: { ...e.response, response: { account: { tokenSource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" } } } } : e)).join("\n")],
    ["native.json.stdin.jsonl", () => JSON.stringify({ type: "user", message: { content: "different prompt" } })],
  ] as const;
  for (const [name, change] of changes) {
    const f = fixture("Odysseus complete review packet");
    try {
      const value = change(f); writeFileSync(join(f.directory, name), typeof value === "string" ? value : JSON.stringify(value));
      const changed = { ...f.receipt, evidence: saveEvidenceBundle(f.directory) }; // Even a refreshed manifest cannot replace behavior proof.
      expect(admitExactPackets([f.expected], [changed])).toBe(false);
    } finally { f.close(); }
  }
  const f = fixture("Odysseus complete review packet");
  try {
    writeFileSync(join(f.directory, "native.json.stderr.bin"), "changed after collection");
    expect(readFileSync(join(f.directory, "native.json.stderr.bin"), "utf8")).not.toBe("");
    expect(admitExactPackets([f.expected], [f.receipt])).toBe(false);
  } finally { f.close(); }
});

test("live readonly review refuses injected fetch before any physical or native dispatch", async () => {
  let dispatched = 0;
  await expect(runNative("/unused", "/unused", "offline-fixture", "unused", { readOnlyReview: true,
    fetch: async () => { dispatched++; return new Response("unused"); } })).rejects.toThrow("Live native review refuses injected transports");
  expect(dispatched).toBe(0);
});


test("scripted original root grant stays ineligible after execution/provider provenance is relabelled",()=>{
  const f=fixture("Odysseus complete review packet","offline-native-scripted");
  try{
    writeFileSync(join(f.directory,"execution.json"),JSON.stringify({...f.execution,kind:"subscription-native-direct"}));
    const relabelled={...f.receipt,evidence:saveEvidenceBundle(f.directory)};
    expect(admitExactPackets([f.expected],[relabelled])).toBe(false);
  }finally{f.close();}
});
