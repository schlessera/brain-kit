import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases, detect, DETECTION_DAY, prepareBenchmark } from "../scripts/evals/audit-capabilities/benchmark";
import { runtimeFreeze, sha } from "../scripts/evals/audit-capabilities/freeze";
import { main } from "../scripts/evals/audit-capabilities/live";
import { MODEL } from "../scripts/evals/audit-capabilities/protocol";
import { buildReviewPacket, buildReviewPlan } from "../scripts/evals/audit-capabilities/review-packets";
import * as evidence from "../scripts/evals/audit-capabilities/review-evidence";
import type { RootPaidPolicy } from "../scripts/evals/audit-capabilities/review-policy";

const root = mkdtempSync(join(tmpdir(), "audit-scored-wiring-"));
let reviewPlan: ReturnType<typeof buildReviewPlan>["reviewPlan"], reviewPlanSha: string;
let frozen: ReturnType<typeof runtimeFreeze>, detectedRaw: string, proofRaw: string;
let policies: Record<string, RootPaidPolicy>, review: any, sequence = 0;
const wiringClock = new Date(DETECTION_DAY + "T12:00:00.000Z");
beforeAll(async () => {
  // Wiring proof uses a declared test clock; live/keyless proof retains real UTC.
  setSystemTime(wiringClock);
  const rows = [];
  for (const f of cases) { const p = await prepareBenchmark(f); try { rows.push({ id: f.id, detected: await detect(p) }); } finally { p.close(); } }
  detectedRaw = JSON.stringify(rows); frozen = runtimeFreeze();
  proofRaw = JSON.stringify({ freezeSha: frozen.freezeSha, detectedSha: sha(detectedRaw), testsExitCode: 0, typecheckExitCode: 0, lintExitCode: 0, leakageGate: "clean", tests: "synthetic entry wiring only" });
  const runtime = { sdk: frozen.binaries.claude.sdkVersion, nativeSha: frozen.binaries.claude.sha256, nativeMode: frozen.binaries.claude.mode, bunSha: frozen.binaries.bun.sha256, bunVersion: frozen.binaries.bun.version, bunMode: frozen.binaries.bun.mode };
  ({ reviewPlan, reviewPlanSha } = buildReviewPlan(frozen, detectedRaw, proofRaw));
  policies = Object.fromEntries(reviewPlan.map(packet => {
    const nonce = sha("synthetic Odysseus policy " + packet.key);
    return [packet.key, { version: 1, issue: 841, authorizationUrl: "https://github.com/schlessera/brain-kit/issues/838#issuecomment-6065882737", allowOverage: true, basis: "actual additional billed charges", grantNonce: nonce, consumedMarkerPath: join(root, nonce + ".json"), perIssueCapUsd: 15, aggregateCapUsd: 150, remainingUpperUsd: 15, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), freezeSha: frozen.freezeSha, proofSha: sha(proofRaw), detectedSha: sha(detectedRaw), protocolSha: sha(JSON.stringify(frozen.protocol)), runtimeSha: sha(JSON.stringify(runtime)), promptSha: buildReviewPacket(frozen, detectedRaw, proofRaw, packet.key).promptSha, canonicalModel: MODEL, maxPhysicalRequests: 24, contextWindowTokens: 1_000_000, maxInputTokens: 1_000_000, maxInputBytes: 2_000_000, maxOutputTokens: 128_000, inputUsdPerMillionUpper: 8, outputUsdPerMillionUpper: 20, invoiceUsd: null } satisfies RootPaidPolicy];
  }));
  // Deliberately synthetic metadata. The real raw-artifact validator rejects it;
  // the scoped spy below observes wiring only and never supplies live approval.
  review = { approval: "APPROVED", model: MODEL, freezeSha: frozen.freezeSha, detectedSha: sha(detectedRaw), verificationSha: sha(proofRaw), packetCaseIds: cases.map(f => f.id), nativeReceipts: reviewPlan.map(packet => ({ packet, model: MODEL, approval: "APPROVED", freezeSha: frozen.freezeSha, detectedSha: sha(detectedRaw), verificationSha: sha(proofRaw), reviewPlanSha, promptSha: policies[packet.key]!.promptSha, reviewDriverSha: frozen.sources["scripts/evals/audit-capabilities/review.ts"], apiEquivalent: { lowerUsd: .000012, upperUsd: .000012 }, promptReleased: true, credentials: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }, result: { subtype: "success", is_error: false, result: "APPROVED synthetic wiring fixture", modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 } } }, init: { model: MODEL, apiKeySource: "none", cli: frozen.binaries.claude.cliVersion }, childClosed: { code: 0, signal: null } })) };
  writeFileSync(join(root, "review.json"), JSON.stringify(review)); writeFileSync(join(root, "detected.json"), detectedRaw); writeFileSync(join(root, "proof.json"), proofRaw);
});
afterAll(() => { setSystemTime(); rmSync(root, { recursive: true, force: true }); });

async function invoke(raw: string | undefined, stub = true, unreadable = false) {
  const argv = process.argv, env = { live: process.env.BRAIN_LIVE_EVAL, cap: process.env.BRAIN_EVAL_REMAINING_USD };
  const out = join(root, "output-" + ++sequence), policyPath = join(root, "policies-" + sequence + ".json");
  if (raw !== undefined && !unreadable) writeFileSync(policyPath, raw);
  const seen: Array<RootPaidPolicy | undefined> = [];
  const replay = stub ? spyOn(evidence, "validateReviewEvidence").mockImplementation(expected => { seen.push(expected.paidPolicy); return true; }) : null;
  let forwards = 0;
  const http = Object.assign(async () => { forwards++; throw Error("Unexpected HTTP forwarding"); }, { preconnect() { forwards++; throw Error("Unexpected HTTP preconnect"); } });
  const transport = spyOn(globalThis, "fetch").mockImplementation(http);
  process.argv = [process.execPath, "scripts/evals/audit-capabilities/live.ts", out, join(root, "review.json"), join(root, "detected.json"), join(root, "proof.json"), ...(raw === undefined ? [] : [policyPath])];
  process.env.BRAIN_LIVE_EVAL = "841";
  // After the real combined gate, this existing allocation guard stops the
  // scored loop. No positive wiring fixture can request provider inference.
  process.env.BRAIN_EVAL_REMAINING_USD = "0";
  let failure = "";
  try { await main(); } catch (error) { failure = String(error); }
  finally {
    process.argv = argv; replay?.mockRestore(); transport.mockRestore();
    for (const [key, value] of [["BRAIN_LIVE_EVAL", env.live], ["BRAIN_EVAL_REMAINING_USD", env.cap]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  return { seen, forwards, failure, outputCreated: existsSync(out) };
}

test("actual scored entry forwards all planned independently supplied policies through the real combined gate", async () => {
  const r = await invoke(JSON.stringify(policies));
  // Mapping is asserted first: removing argument five must fail here, rather
  // than at a loader, empty fixture or later allocation assertion.
  expect(r.seen).toEqual(reviewPlan.map(p => policies[p.key]));
  expect(r.seen).toHaveLength(reviewPlan.length); expect(Object.keys(policies)).toHaveLength(reviewPlan.length);
  expect(r.failure).toContain("Invalid actual-charge allowance"); expect(r.forwards).toBe(0);
});

for (const [name, raw] of [["missing", undefined], ["invalid JSON", "{"], ["null", "null"], ["array", "[]"], ["empty", "{}"]] as const) test(`${name} independent map refuses at scored entry before replay or HTTP`, async () => {
  const r = await invoke(raw);
  expect(r.seen).toHaveLength(0); expect(r.forwards).toBe(0); expect(r.outputCreated).toBe(false);
  expect(r.failure).not.toContain("Invalid actual-charge allowance");
});

for (const field of ["proofSha", "promptSha", "freezeSha", "runtimeSha"] as const) test(`substituted ${field} policy refuses at scored entry before replay or HTTP`, async () => {
  const changed = structuredClone(policies); changed[reviewPlan[0]!.key]![field] = sha("substituted Odysseus authority");
  const r = await invoke(JSON.stringify(changed));
  expect(r.seen).toHaveLength(0); expect(r.failure).toContain("Independent packet paid policy");
  expect(r.forwards).toBe(0); expect(r.outputCreated).toBe(false);
});

test("complete external map never promotes synthetic review metadata to semantic approval", async () => {
  const r = await invoke(JSON.stringify(policies), false);
  expect(r.forwards).toBe(0); expect(r.outputCreated).toBe(false);
  expect(r.failure).toContain("not exact prompt/proof-frozen");
});

test("unreadable independent policy input refuses before replay or HTTP", async () => {
  const r = await invoke(JSON.stringify(policies), true, true);
  expect(r.seen).toHaveLength(0); expect(r.forwards).toBe(0); expect(r.outputCreated).toBe(false);
  expect(r.failure).toContain("ENOENT");
});

for (const variant of ["missing packet", "unknown packet", "invalid packet shape"] as const) test(`${variant} map refuses before replay or HTTP`, async () => {
  const changed = structuredClone(policies);
  if (variant === "missing packet") delete changed[reviewPlan.at(-1)!.key];
  else if (variant === "unknown packet") changed["unknown"] = changed[reviewPlan[0]!.key]!;
  else changed[reviewPlan[0]!.key] = [] as unknown as RootPaidPolicy;
  const r = await invoke(JSON.stringify(changed));
  expect(r.seen).toHaveLength(0); expect(r.failure).toContain("Independent packet paid policy");
  expect(r.forwards).toBe(0); expect(r.outputCreated).toBe(false);
});

test("policies claimed by the receipt cannot replace the explicit coordinator input", async () => {
  const path = join(root, "review.json"), original = readFileSync(path);
  try {
    writeFileSync(path, JSON.stringify({ ...review, policies, paidPolicies: policies }));
    const r = await invoke(undefined);
    expect(r.seen).toHaveLength(0); expect(r.forwards).toBe(0); expect(r.outputCreated).toBe(false);
    expect(r.failure).toContain("independent policy map required");
  } finally { writeFileSync(path, original); }
});

test("expired completed-policy envelope reaches original replay without freshening authority", async () => {
  const expired = structuredClone(policies);
  for (const p of Object.values(expired)) { p.issuedAt = new Date(Date.now() - 600_000).toISOString(); p.expiresAt = new Date(Date.now() - 300_000).toISOString(); }
  const r = await invoke(JSON.stringify(expired));
  expect(r.seen).toEqual(reviewPlan.map(p => expired[p.key]));
  expect(r.failure).toContain("Invalid actual-charge allowance"); expect(r.forwards).toBe(0);
});

test("a different detection day refuses before replay or HTTP", async () => {
  try {
    setSystemTime(new Date(wiringClock.getTime() + 86_400_000));
    const r = await invoke(JSON.stringify(policies));
    expect(r.seen).toHaveLength(0); expect(r.forwards).toBe(0); expect(r.outputCreated).toBe(false);
    expect(r.failure).toContain("Real audit detection date differs from frozen protocol");
  } finally { setSystemTime(wiringClock); }
});
