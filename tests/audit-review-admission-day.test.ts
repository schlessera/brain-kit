import { afterAll, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETECTION_DAY } from "../scripts/evals/audit-capabilities/benchmark";
import { runtimeFreeze, sha } from "../scripts/evals/audit-capabilities/freeze";
import { createReviewAdmission } from "../scripts/evals/audit-capabilities/review-native";
import { claimPaidGrant, type RootPaidPolicy } from "../scripts/evals/audit-capabilities/review-policy";
import { startRelay } from "../scripts/evals/audit-capabilities/review-relay";

// #1437: the live guard stays bound to the frozen DETECTION_DAY; the offline collector binds the day it ran.
// Only the admission guard's local clock is injected here; the runtime clock is never replaced.
// Kept apart from audit-review-artifacts.test.ts so its offline native launches cannot answer first.
const temp = mkdtempSync(join(tmpdir(), "1437-admission-day-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const dayAfterDetection = () => new Date(Date.parse(DETECTION_DAY + "T12:00:00.000Z") + 86_400_000);

let grantSequence = 0;
function admissionInput(payload: string) {
  const f = runtimeFreeze();
  const runtime = { sdk: f.binaries.claude.sdkVersion, nativeSha: f.binaries.claude.sha256, nativeMode: f.binaries.claude.mode, bunSha: f.binaries.bun.sha256, bunVersion: Bun.version, bunMode: f.binaries.bun.mode };
  const grantNonce = sha("admission-day-grant-" + ++grantSequence), parent = join(temp, "grants");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const policy: RootPaidPolicy = {
    version: 1, grantNonce, consumedMarkerPath: join(parent, grantNonce + ".json"), issue: 841,
    authorizationUrl: "https://github.com/schlessera/brain-kit/issues/838#issuecomment-6065882737", allowOverage: true,
    basis: "actual additional billed charges", perIssueCapUsd: 15, aggregateCapUsd: 150, remainingUpperUsd: 15,
    issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    freezeSha: f.freezeSha, detectedSha: sha("detected"), protocolSha: sha(JSON.stringify(f.protocol)), runtimeSha: sha(JSON.stringify(runtime)),
    promptSha: sha(payload), proofSha: sha("proof"), canonicalModel: "claude-sonnet-5-5", maxPhysicalRequests: 24, contextWindowTokens: 1000000,
    maxInputTokens: 1000000, maxInputBytes: 2_000_000, maxOutputTokens: 128000, inputUsdPerMillionUpper: 8, outputUsdPerMillionUpper: 20, invoiceUsd: null,
  };
  return { frozen: f, payload, proofSha: policy.proofSha, detectedSha: policy.detectedSha, policy };
}
async function relayAttempt(guard: ReturnType<typeof createReviewAdmission>, payload: string) {
  let forwarded = 0;
  const relay = startRelay({ oauthToken: "offline-auth", beforeForward: guard.beforeForward, save: () => {}, fetch: async () => { forwarded++; throw Error("controlled failure after admission"); } });
  try {
    const r = await fetch(relay.url + "/v1/messages", { method: "POST", headers: { authorization: "Bearer offline-auth" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1000, messages: [{ role: "user", content: payload }], tools: [], output_config: { effort: "low" } }) });
    return { forwarded, status: r.status, call: relay.calls.at(-1) };
  } finally { await relay.stop(); }
}

test("live admission refuses a stale frozen detection day before forwarding and names the guard", async () => {
  const payload = "Odysseus stale-day live review", input = admissionInput(payload);
  const stale = await relayAttempt(createReviewAdmission({ ...input, now: dayAfterDetection }), payload);
  expect(stale.forwarded).toBe(0);
  expect(stale.status).toBe(403);
  expect(stale.call?.forwarded).toBe(false);
  expect(stale.call?.failure).toBe(`Root paid reservation refused: Actual detection day ${dayAfterDetection().toISOString().slice(0, 10)} differs from bound ${DETECTION_DAY}`);
  // Refused before the grant was consumed.
  expect(() => claimPaidGrant(input.policy)).not.toThrow();
});

test("offline-bound admission forwards on a later day without moving the live frozen day", async () => {
  const payload = "Odysseus later-day offline control", input = admissionInput(payload), later = dayAfterDetection(), laterDay = later.toISOString().slice(0, 10);
  expect(laterDay).not.toBe(DETECTION_DAY);
  const offline = await relayAttempt(createReviewAdmission({ ...input, detectionDay: laterDay, now: () => later }), payload);
  expect(offline.forwarded).toBe(1);
  expect(offline.call?.forwarded).toBe(true);
  expect(lstatSync(input.policy.consumedMarkerPath).isFile()).toBe(true);
});
