import { beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cases, detect, prepareBenchmark } from "../scripts/evals/audit-capabilities/benchmark";
import { repo, runtimeFreeze, sha } from "../scripts/evals/audit-capabilities/freeze";
import { MODEL } from "../scripts/evals/audit-capabilities/protocol";
import { buildReviewPacket, combinedReview, COMMON_REVIEW_FILES, MAX_PACKET_BYTES, REVIEW_FILES, buildReviewPlan } from "../scripts/evals/audit-capabilities/review-packets";
let reviewPlan: ReturnType<typeof buildReviewPlan>["reviewPlan"], reviewPlanSha: string;
let frozen: ReturnType<typeof runtimeFreeze>, detectedRaw: string, proofRaw: string;
beforeAll(async () => {
  const detected = [];
  for (const f of cases) { const p = await prepareBenchmark(f); try { detected.push({ id: f.id, detected: await detect(p) }); } finally { p.close(); } }
  detectedRaw = JSON.stringify(detected); frozen = runtimeFreeze();
  // This synthetic receipt exercises binding only; it is never published as a verification or model approval.
  proofRaw = JSON.stringify({ freezeSha: frozen.freezeSha, detectedSha: sha(detectedRaw), testsExitCode: 0, typecheckExitCode: 0, lintExitCode: 0, leakageGate: "clean", tests: "controlled binding fixture" });
  ({ reviewPlan, reviewPlanSha } = buildReviewPlan(frozen, detectedRaw, proofRaw));
});
function receipts(): any[] { return reviewPlan.map(packet => ({ packet, model: MODEL, approval: "APPROVED", freezeSha: frozen.freezeSha, detectedSha: sha(detectedRaw), verificationSha: sha(proofRaw), reviewPlanSha, promptSha: buildReviewPacket(frozen, detectedRaw, proofRaw, packet.key).promptSha, reviewDriverSha: frozen.sources["scripts/evals/audit-capabilities/review.ts"], apiEquivalent: { lowerUsd: .000012, upperUsd: .000012 }, promptReleased: true, credentials: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }, rateLimits: [{ isUsingOverage: false }], result: { subtype: "success", is_error: false, result: "APPROVED controlled predicate fixture", modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 } } }, init: { model: MODEL, apiKeySource: "none", cli: frozen.binaries.claude.cliVersion }, subscriptionOverageState: "reported inactive", childClosed: { code: 0, signal: null } })); }
function withSources(sourceText: Map<string, string>, check: (changed: typeof frozen, proof: string) => void) {
  const originalRead = fs.readFileSync, changed = structuredClone(frozen);
  for (const [path, raw] of sourceText) changed.sources[path.slice(repo.length + 1)] = sha(raw);
  const { freezeSha: _, ...identity } = changed;
  changed.freezeSha = sha(JSON.stringify(identity));
  const proof = JSON.stringify({ ...JSON.parse(proofRaw), freezeSha: changed.freezeSha });
  const read = spyOn(fs, "readFileSync").mockImplementation(((path: any, options: any) => {
    const raw = sourceText.get(String(path));
    return raw === undefined ? originalRead(path, options) : options === "utf8" ? raw : Buffer.from(raw);
  }) as typeof fs.readFileSync);
  try { check(changed, proof); } finally { read.mockRestore(); }
}
test("lossless bounded packets cover every authored case and whole behavioral source exactly once", () => {
  expect(reviewPlan.filter(p => p.kind === "source").length).toBeGreaterThanOrEqual(4);
  expect(reviewPlan.filter(p => p.kind === "cases")).toHaveLength(4);
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
test("source growth keeps complete serialized packets within the byte envelope", () => {
  const grown = new Map(REVIEW_FILES.filter(path => !(COMMON_REVIEW_FILES as readonly string[]).includes(path))
    .map(path => [join(repo, path), readFileSync(join(repo, path), "utf8") + "\n" + "Odysseus source growth. ".repeat(100)]));
  withSources(grown, (changed, proof) => {
    const planned = buildReviewPlan(changed, detectedRaw, proof);
    expect(buildReviewPlan(changed, detectedRaw, proof)).toEqual(planned);
    expect(planned.reviewPlan.flatMap(p => p.sourcePaths).sort()).toEqual([...grown.keys()].map(p => p.slice(repo.length + 1)).sort());
    for (const packet of planned.reviewPlan) {
      const built = buildReviewPacket(changed, detectedRaw, proof, packet.key);
      expect(built.bytes).toBeLessThanOrEqual(MAX_PACKET_BYTES);
      expect(built.reviewPlanSha).toBe(planned.reviewPlanSha);
      expect(buildReviewPacket(changed, detectedRaw, proof, packet.key).payload).toBe(built.payload);
      for (const path of packet.sourcePaths) expect(built.payload).toContain(grown.get(join(repo, path))!);
    }
    expect(planned.reviewPlan.filter(p => p.kind === "source").length).toBeGreaterThan(4);
  });
});
test("exact whole-file search preserves four packets when greedy balancing cannot fit", () => {
  const paths = REVIEW_FILES.filter(path => !(COMMON_REVIEW_FILES as readonly string[]).includes(path));
  // Four 3-unit and six 2-unit files defeat largest-first balancing (7/7/5/5).
  // A feasible four-bin partition is 6/6/6/6, with the remaining tiny files.
  const sourceText = new Map(paths.map((path, index) => [join(repo, path), "x".repeat(index < 4 ? 51_000 : index < 10 ? 34_000 : 1)]));
  withSources(sourceText, (changed, proof) => {
    const planned = buildReviewPlan(changed, detectedRaw, proof);
    expect(planned.reviewPlan.filter(p => p.kind === "source")).toHaveLength(4);
    expect(planned.reviewPlan.flatMap(p => p.sourcePaths).sort()).toEqual([...paths].sort());
    for (const packet of planned.reviewPlan) expect(buildReviewPacket(changed, detectedRaw, proof, packet.key).bytes).toBeLessThanOrEqual(MAX_PACKET_BYTES);
  });
});
test("double-digit source keys stay bounded and deterministic with multibyte source text", () => {
  const paths = REVIEW_FILES.filter(path => !(COMMON_REVIEW_FILES as readonly string[]).includes(path));
  const sourceText = new Map(paths.map((path, index) => [join(repo, path), index < 12 ? "Ω".repeat(50_000) : "Odysseus"]));
  withSources(sourceText, (changed, proof) => {
    const planned = buildReviewPlan(changed, detectedRaw, proof);
    expect(planned.reviewPlan.filter(p => p.kind === "source")).toHaveLength(12);
    expect(buildReviewPlan(changed, detectedRaw, proof)).toEqual(planned);
    for (const packet of planned.reviewPlan) expect(buildReviewPacket(changed, detectedRaw, proof, packet.key).bytes).toBeLessThanOrEqual(MAX_PACKET_BYTES);
  });
});
test("an indivisible oversized source refuses without truncation", () => {
  withSources(new Map([[join(repo, REVIEW_FILES[0]), "Ω".repeat(MAX_PACKET_BYTES)]]), (changed, proof) => {
    expect(() => buildReviewPlan(changed, detectedRaw, proof)).toThrow("No lossless whole-source partition");
  });
});
test("verification summary bytes participate in source planning", () => {
  const paths = REVIEW_FILES.filter(path => !(COMMON_REVIEW_FILES as readonly string[]).includes(path));
  withSources(new Map(paths.map(path => [join(repo, path), "Odysseus. ".repeat(1_000)])), (changed, proof) => {
    const small = buildReviewPlan(changed, detectedRaw, proof);
    const large = JSON.stringify({ ...JSON.parse(proof), tests: "Odysseus proof. ".repeat(2_200) });
    const planned = buildReviewPlan(changed, detectedRaw, large);
    expect(planned.reviewPlan.filter(p => p.kind === "source").length).toBeGreaterThan(small.reviewPlan.filter(p => p.kind === "source").length);
    for (const packet of planned.reviewPlan) expect(buildReviewPacket(changed, detectedRaw, large, packet.key).bytes).toBeLessThanOrEqual(MAX_PACKET_BYTES);
  });
});
test("source substitution and unknown packet keys refuse before review", () => {
  const changed = structuredClone(frozen); changed.sources[REVIEW_FILES[0]] = sha("substituted source");
  expect(() => buildReviewPacket(changed, detectedRaw, proofRaw, reviewPlan[0]!.key)).toThrow("Review source changed");
  expect(() => buildReviewPacket(frozen, detectedRaw, proofRaw, "source-unknown")).toThrow("Unknown/empty review packet");
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
  const valid = receipts(); expect(() => combinedReview(valid.slice(1), frozen, detectedRaw, proofRaw)).toThrow("All planned");
  const duplicate = receipts(); duplicate[1] = duplicate[0]!; expect(() => combinedReview(duplicate, frozen, detectedRaw, proofRaw)).toThrow("Review packet keys");
  const extra = receipts(); extra.push(extra[0]); expect(() => combinedReview(extra, frozen, detectedRaw, proofRaw)).toThrow("All planned");
  const substituted = receipts(); substituted[0].packet = { ...substituted[0].packet, key: "source-unknown" };
  expect(() => combinedReview(substituted, frozen, detectedRaw, proofRaw)).toThrow("Review packet keys");
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
