import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitExactPackets, type ReviewReceipt } from "../packages/ui-server/evals/triage/experiment/review-admission";
import { saveEvidenceBundle, type RuntimeIdentity } from "../packages/ui-server/evals/triage/experiment/review-evidence";
import { sha } from "../packages/ui-server/evals/triage/experiment/adapter";
import { CLEARED_API_CREDENTIALS } from "../packages/core/src/providers/agents/claude-subscription";

import { consumeGrant } from "../packages/ui-server/evals/triage/experiment/grant";
import { ReviewBudget, EXTRA_USAGE_AUTHORIZATION, type RootPaidPolicy } from "../packages/ui-server/evals/triage/experiment/paid-policy";

const model = "claude-sonnet-5-5";
const runtime: RuntimeIdentity = { sdk: "0.3.293", nativeSha: "fixture-native-byte-hash", nativeMode: 0o755, bunSha: "fixture-bun-byte-hash", bunVersion: "1.4.2", bunMode: 0o755 };
/** Synthetic complete format control; never an actual provider approval. No transport runs here. */
function fixture(prompt: string, kind = "subscription-native-direct", paid = false) {
  const directory = mkdtempSync(join(tmpdir(), "brain-triage-review-format-"));
  const usage = { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const account = { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" };
  const settings = { effective: { apiKeyHelper: "", env: { ...CLEARED_API_CREDENTIALS } }, sources: [] };
  const init = { type: "system", subtype: "init", model, apiKeySource: "none", claude_code_version: "2.1.293", tools: [] };
  const rate = { type: "rate_limit_event", rate_limit_info: { status: paid ? "rejected" : "allowed", ...(paid ? { overageStatus: "allowed" } : {}), isUsingOverage: paid } };
  const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "APPROVED", modelUsage: {
    [model]: { inputTokens: 10, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      canonicalModel: model, provider: "firstParty", costBasis: "list", contextWindow: 1_000_000, maxOutputTokens: 128_000 } } };
  const output = [ { type: "control_response", response: { request_id: "brain-initialize", subtype: "success", response: { account } } },
    { type: "control_response", response: { request_id: "brain-settings", subtype: "success", response: settings } }, init, rate, result ];
  const startUsage = { ...usage, output_tokens: 0 };
  const response = [ { type: "message_start", message: { model, usage: startUsage } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "APPROVED" } },
    { type: "message_delta", usage: { output_tokens: 7 } }, { type: "message_stop" } ].map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
  const request = JSON.stringify({ model, ...(paid ? { max_tokens: 8000 } : {}), output_config: { effort: "low" }, tools: [], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] });
  const call = { authRoute: "subscription-oauth-no-api-key", upstream: "https://api.anthropic.com/v1/messages", requestMethod: "POST", requestPath: "/v1/messages",
    rateHeaders:paid?{"anthropic-ratelimit-unified-status":"rejected","anthropic-ratelimit-unified-overage-status":"allowed"}:{},status: 200, requestedModel: model, servedModel: model, outcome: "completed", finished: true, responseClosed: true, responseEof: true, responseCancelled: false,
    rawRequestBase64: Buffer.from(request).toString("base64"), requestSha: sha(request), stateBytes: Buffer.byteLength(request),
    rawResponseBase64: Buffer.from(response).toString("base64"), rawResponseSha: sha(response), responseBytes: Buffer.byteLength(response),
    usage, rawUsageEvents: [{ type: "message_start", usage: startUsage }, { type: "message_delta", usage: { output_tokens: 7 } }],
    apiEquivalent: { lowerUsd: 0.00009, upperUsd: 0.00009, unknownCacheTokens: 0 }, actualInvoiceUsd: null };
  const native:any = { init, account, settings, rates: [rate], result, failure: null, exitCode: 0, signalCode: null, finished: true,
    drained: true, stdoutComplete: true, stderrDrained: true, promptReleased: true, overage: paid ? "active" : "inactive observed", additionalBilledUsd: null, apiEquivalent: { lowerUsd: 0.00009, upperUsd: 0.00009, unknownCacheTokens: 0 } };
  const execution: any = { kind, transport: "global-fetch", upstream: call.upstream, freezeSha: paid ? sha("same-freeze") : "same-freeze", promptSha: sha(prompt), readOnlyReview: true,
    runtime, relayClosed: true, runnerFailure: null, additionalBilledUsd: null };
  const expected: any = { key: "cases-1", freezeSha: execution.freezeSha, promptSha: sha(prompt), runtime };
  if (paid) {
    const binding = { freezeSha: execution.freezeSha, inputSha: sha("input"), protocolSha: sha("protocol"), runtimeSha: sha(JSON.stringify(runtime)), proofSha: sha("proof"), promptSha: sha(prompt) };
    const grantNonce=sha(directory);
    const policy: RootPaidPolicy = { ...binding, grantNonce,consumedMarkerPath:join(directory,`${grantNonce}.json`), version: 1, issue: 848, authorizationUrl: EXTRA_USAGE_AUTHORIZATION, allowOverage: true, basis: "actual additional billed charges", perIssueCapUsd: 15, aggregateCapUsd: 150, remainingUpperUsd: 15, issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+60000).toISOString(), canonicalModel: model, maxPhysicalRequests: 24, maxInputBytes: 5_000_000, maxInputTokens: 1_000_000, contextWindowTokens: 1_000_000, maxOutputTokens: 128000, inputUsdPerMillionUpper: 8, outputUsdPerMillionUpper: 20, invoiceUsd: null };
    const budget = new ReviewBudget(policy, binding, () => {}); budget.settle(budget.reserve(Buffer.from(request)), usage);
    execution.startedAtUtc=new Date(budget.entries[0]!.at-1).toISOString();
    const claim=consumeGrant(policy,binding,budget.entries[0]!.at);execution.grantClaimSha=claim.sha;
    execution.paidAdmission = { policy, entries: budget.entries }; expected.binding = binding; expected.paidPolicySha = sha(JSON.stringify(policy));
  }
  writeFileSync(join(directory,"grant.json"),paid?readFileSync(execution.paidAdmission.policy.consumedMarkerPath):"null");
  if(paid){native.grantClaimSha=execution.grantClaimSha;native.paidPolicySha=expected.paidPolicySha;}
  for (const [name, value] of Object.entries({ "execution.json": execution, "native.json": native, "physical.json": [call] }))
    writeFileSync(join(directory, name), JSON.stringify(value));
  writeFileSync(join(directory, "native.json.stdout.jsonl"), output.map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(directory, "native.json.stdin.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
  writeFileSync(join(directory, "native.json.stderr.bin"), "");
  const receipt: ReviewReceipt = { ...expected, approved: true, model, actualCli: "2.1.293", finished: true, drained: true,
    stdoutComplete: true, callsComplete: true, overage: paid ? "active" : "inactive observed", actualProvider: true, scope: "complementary-semantic-review",
    authorFamily: "gpt", reviewerFamily: "claude", evidence: saveEvidenceBundle(directory) };
  return { directory, expected, receipt, native, execution, call, output, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("flag-only APPROVED metadata cannot stand in for complete actually collected review artifacts", () => {
  const f = fixture("Odysseus complete review packet");
  try {
    expect(admitExactPackets([], [])).toBe(false);
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


test("complete explicit root paid review reparses all raw evidence and reservations before semantic format admission", () => {
  const f = fixture("Complete Odysseus paid review format", "subscription-native-direct", true);
  try {
    expect(admitExactPackets([f.expected], [f.receipt])).toBe(true); // Synthetic format control, not collected provider approval.
    expect(admitExactPackets([{ ...f.expected, paidPolicySha: undefined }], [f.receipt])).toBe(false);
    for(const rateHeaders of [{},{"anthropic-ratelimit-unified-status":"rejected","anthropic-ratelimit-unified-overage-status":"rejected"}]){
      writeFileSync(join(f.directory,"physical.json"),JSON.stringify([{...f.call,rateHeaders}]));
      expect(admitExactPackets([f.expected],[{...f.receipt,evidence:saveEvidenceBundle(f.directory)}])).toBe(false);
    }
    writeFileSync(join(f.directory,"physical.json"),JSON.stringify([f.call]));
    for(const messages of [[{role:"user",content:"Complete Odysseus paid review format"},{role:"user",content:"unreviewed extra"}],[{role:"user",content:[{type:"text",text:"Complete Odysseus paid review format"},{type:"text",text:"unreviewed extra"}]}]]){
      const request=JSON.stringify({...JSON.parse(Buffer.from(f.call.rawRequestBase64,"base64").toString()),messages});
      writeFileSync(join(f.directory,"physical.json"),JSON.stringify([{...f.call,rawRequestBase64:Buffer.from(request).toString("base64"),requestSha:sha(request),stateBytes:Buffer.byteLength(request)}]));
      expect(admitExactPackets([f.expected],[{...f.receipt,evidence:saveEvidenceBundle(f.directory)}])).toBe(false);
    }
    writeFileSync(join(f.directory,"physical.json"),JSON.stringify([f.call]));
    const original = structuredClone(f.execution);
    for (const alter of [
      (e: any) => { delete e.paidAdmission; },
      (e: any) => { e.paidAdmission.policy.remainingUpperUsd = 0; },
      (e: any) => { e.paidAdmission.entries[0].reservedUpperUsd = 0; },
      (e: any) => { e.paidAdmission.entries[0].status = "unknown"; },
      (e: any) => { e.paidAdmission.entries[0].rawUsage.output_tokens = 0; },
    ]) {
      const changed = structuredClone(original); alter(changed); writeFileSync(join(f.directory, "execution.json"), JSON.stringify(changed));
      expect(admitExactPackets([f.expected], [{ ...f.receipt, evidence: saveEvidenceBundle(f.directory) }])).toBe(false);
    }
  } finally { f.close(); }
  const offline = fixture("Complete Odysseus offline paid format", "offline-native-scripted", true);
  try { expect(admitExactPackets([offline.expected], [offline.receipt])).toBe(false); } finally { offline.close(); }
});

test("literal physical reparse refuses extra user source even with self-consistent budget hashes",()=>{
 const f=fixture("Complete Odysseus sole USER review","subscription-native-direct",true);
 try{
  expect(admitExactPackets([f.expected],[f.receipt])).toBe(true); // Format only.
  const r=JSON.parse(Buffer.from(f.call.rawRequestBase64,"base64").toString());
  r.messages.push({role:"user",content:"Extra unreviewed source"});const literal=JSON.stringify(r),n=Buffer.byteLength(literal);
  const call={...f.call,rawRequestBase64:Buffer.from(literal).toString("base64"),requestSha:sha(literal),stateBytes:n};
  const execution=structuredClone(f.execution),entry=execution.paidAdmission.entries[0];
  entry.requestSha=call.requestSha;entry.inputBound=Math.min(n,1_000_000);entry.reservedUpperUsd=(entry.inputBound*8+entry.outputBound*20)/1e6;
  writeFileSync(join(f.directory,"physical.json"),JSON.stringify([call]));writeFileSync(join(f.directory,"execution.json"),JSON.stringify(execution));
  expect(admitExactPackets([f.expected],[{...f.receipt,evidence:saveEvidenceBundle(f.directory)}])).toBe(false);
 }finally{f.close();}
});
