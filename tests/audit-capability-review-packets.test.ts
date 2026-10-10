import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cases, detect, prepareBenchmark } from "../scripts/evals/audit-capabilities/benchmark";
import { repo, runtimeFreeze, sha } from "../scripts/evals/audit-capabilities/freeze";
import { MODEL } from "../scripts/evals/audit-capabilities/protocol";
import { buildReviewPacket, combinedReview, COMMON_REVIEW_FILES, MAX_PACKET_BYTES, REVIEW_FILES, reviewPlan, reviewPlanSha } from "../scripts/evals/audit-capabilities/review-packets";
let frozen: ReturnType<typeof runtimeFreeze>, detectedRaw: string, proofRaw: string;
beforeAll(async () => {
  const detected = [];
  for (const f of cases) { const p = await prepareBenchmark(f); try { detected.push({ id: f.id, detected: await detect(p) }); } finally { p.close(); } }
  detectedRaw = JSON.stringify(detected); frozen = runtimeFreeze();
  // This synthetic receipt exercises binding only; it is never published as a verification or model approval.
  proofRaw = JSON.stringify({ freezeSha: frozen.freezeSha, detectedSha: sha(detectedRaw), testsExitCode: 0, typecheckExitCode: 0, lintExitCode: 0, leakageGate: "clean", tests: "controlled binding fixture" });
});
function receipts(): any[] { return reviewPlan.map(packet => ({ packet, model: MODEL, approval: "APPROVED", freezeSha: frozen.freezeSha, detectedSha: sha(detectedRaw), verificationSha: sha(proofRaw), reviewPlanSha, promptSha: buildReviewPacket(frozen, detectedRaw, proofRaw, packet.key).promptSha, reviewDriverSha: frozen.sources["scripts/evals/audit-capabilities/review.ts"], apiEquivalent: { lowerUsd: .000012, upperUsd: .000012 }, promptReleased: true, credentials: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }, rateLimits: [{ isUsingOverage: false }], result: { subtype: "success", is_error: false, result: "APPROVED controlled predicate fixture", modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 } } }, init: { model: MODEL, apiKeySource: "none", cli: frozen.binaries.claude.cliVersion }, subscriptionOverageState: "reported inactive", childClosed: { code: 0, signal: null } })); }
test("eight lossless bounded packets cover every authored case and whole behavioral source exactly once", () => {
  expect(reviewPlan).toHaveLength(8);
  const ids = reviewPlan.flatMap(p => p.caseIds), paths = [...COMMON_REVIEW_FILES, ...reviewPlan.flatMap(p => p.sourcePaths)];
  expect(ids.length).toBe(26); expect(new Set(ids).size).toBe(26); expect([...ids].sort()).toEqual(cases.map(f => f.id).sort());
  // The shared Sonnet 5.5 rates the spend accounting uses are reviewed in full (#1239).
  expect(paths).toContain("scripts/measure-sonnet55-cost.ts");
  expect(paths.length).toBeGreaterThan(25); expect(new Set(paths).size).toBe(paths.length); expect([...paths].sort()).toEqual([...REVIEW_FILES].sort());
  for (const plan of reviewPlan) {
    const built = buildReviewPacket(frozen, detectedRaw, proofRaw, plan.key);
    expect(built.bytes).toBeLessThanOrEqual(MAX_PACKET_BYTES); expect(built.promptSha).toBe(sha(built.payload));
    for (const path of [...COMMON_REVIEW_FILES, ...plan.sourcePaths]) expect(built.payload).toContain(readFileSync(join(repo, path), "utf8"));
    for (const id of plan.caseIds) expect(built.payload).toContain(JSON.stringify(cases.find(f => f.id === id)));
  }
});
test("combined gate rebuilds prompt bytes and binds exact verification before approval", () => {
  const valid = receipts(); expect(()=>combinedReview(valid,frozen,detectedRaw,proofRaw)).toThrow("not exact prompt/proof-frozen");
  const stalePrompt = receipts(); stalePrompt[0]!.promptSha = sha("a different complete prompt");
  expect(() => combinedReview(stalePrompt, frozen, detectedRaw, proofRaw)).toThrow("not exact prompt/proof-frozen");
  const staleProofReceipt = receipts(); staleProofReceipt[0]!.verificationSha = sha("a different verification receipt");
  expect(() => combinedReview(staleProofReceipt, frozen, detectedRaw, proofRaw)).toThrow("not exact prompt/proof-frozen");
  const changedProof = JSON.stringify({ ...JSON.parse(proofRaw), tests: "another verification receipt" });
  expect(() => combinedReview(valid, frozen, detectedRaw, changedProof)).toThrow("not exact prompt/proof-frozen");
});
test("combined gate refuses absent/duplicate source packets, non-success native result and unfinished drain", () => {
  const valid = receipts(); expect(() => combinedReview(valid.slice(1), frozen, detectedRaw, proofRaw)).toThrow("All eight");
  const duplicate = receipts(); duplicate[1] = duplicate[0]!; expect(() => combinedReview(duplicate, frozen, detectedRaw, proofRaw)).toThrow("not exact prompt/proof-frozen");
  const failure = receipts(); failure[0]!.result.subtype = "error_max_budget_usd"; expect(() => combinedReview(failure, frozen, detectedRaw, proofRaw)).toThrow("not exact prompt/proof-frozen");
  const unclosed = receipts(); unclosed[0]!.childClosed.code = 1; expect(() => combinedReview(unclosed, frozen, detectedRaw, proofRaw)).toThrow("not exact prompt/proof-frozen");
});

test("combined gate derives usage and overage from retained native fields rather than receipt claims", () => {
  const missingUsage = receipts(); missingUsage[0]!.result.modelUsage = {};
  expect(() => combinedReview(missingUsage, frozen, detectedRaw, proofRaw)).toThrow("not exact prompt/proof-frozen");
  const extraUsage = receipts(); extraUsage[0]!.rateLimits = [{ isUsingOverage: true }];
  expect(() => combinedReview(extraUsage, frozen, detectedRaw, proofRaw)).toThrow("not exact prompt/proof-frozen");
  const wrongModel = receipts(); wrongModel[0]!.init.model = "claude-sonnet-5";
  expect(() => combinedReview(wrongModel, frozen, detectedRaw, proofRaw)).toThrow("not exact prompt/proof-frozen");
});

 test("metadata-only APPROVED cannot supply semantic review",()=>{expect(()=>combinedReview(receipts(),frozen,detectedRaw,proofRaw)).toThrow("not exact prompt/proof-frozen");});
