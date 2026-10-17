import { SDK_RELAY_PROFILE_TIMEOUT_MS } from "./fixtures/sdk-host-relay-limits.js";
/** Full SDK with the real identity helper; copied startup fixture, not Btrfs admission. */
import { expect } from "bun:test";
import { existsSync } from "node:fs";

if (process.getuid?.() !== 21001 || !existsSync("/usr/local/bin/identity-helper") || process.env.BRAIN_UI_WORKER_IDENTITY_HELPER !== "/usr/local/bin/identity-helper") {
  throw Error("SDK_IDENTITY_QUALIFICATION_REQUIRES_DISPOSABLE_CONTAINER");
}
for (const profile of ["governed", "strict"]) {
  const fixture = new URL("./fixtures/sdk-host-relay-probe.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--preload", "/repo/scripts/test-network-child-preload.ts", fixture, profile, "ordinary", "separate-uid", "--observe-phases"], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/identity-server-private", CLAUDE_CONFIG_DIR: "/identity-server-private/claude",
      BRAIN_UI_WORKER_IDENTITY_HELPER: "/usr/local/bin/identity-helper" }, stdout: "pipe", stderr: "pipe", timeout: SDK_RELAY_PROFILE_TIMEOUT_MS,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  console.log(JSON.stringify({ diagnosticProfile: profile, exit, signal: child.signalCode, phases: stderr.split("\n").filter(line => line.startsWith("SDK_RELAY_PHASE ")) }));
  expect(exit, stderr).toBe(0);
  expect(stderr.split("\n").filter(Boolean).every(line => line.includes("[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]")
    || line.startsWith("SDK_RELAY_PHASE ") || line.startsWith("(Use `bun --trace-warnings")), stderr).toBe(true);
  const value = JSON.parse(stdout);
  expect(value.nativeIdentities, "FULL_SDK_ACTUAL_SEPARATE_IDENTITY").toHaveLength(4);
  for (const identity of value.nativeIdentities) {
    expect(identity, "FULL_SDK_HELPER_PLACEHOLDER_AND_PRIVATE_HOST_STATE").toMatchObject({ uid: 21002, gid: 21001,
      placeholder: true, secrets: false, credentialFile: false, serverSentinel: false });
  }
  expect(value.nativeBinaryMatches, "FULL_SDK_HELPER_ACTUAL_NATIVE_BINARY").toBe(true);
  expect(value.requests.map((request: { credentialIndex: number; model: string; priorMessages: number }) => [request.credentialIndex, request.model, request.priorMessages]),
    "FULL_SDK_HELPER_REFRESH_MODEL_AND_RESUMED_HISTORY").toEqual([[0, "claude-haiku-4-5", 1], [1, "claude-sonnet-4-6", 3], [2, "claude-haiku-4-5", 5]]);
  expect(value.egressRecords.map((record: { outcome: string }) => record.outcome), "FULL_SDK_HELPER_PROXY_AUDIT_AND_CANCEL").toEqual(["completed", "completed", "completed", "cancelled"]);
  expect(value.egressBytes).toBe(value.egressRecords.reduce((sum: number, record: { bytes: number }) => sum + record.bytes, 0));
  expect(value.egressBytes).toBeGreaterThan(6000); expect(value.egressBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(value.hostAfterRefresh).toBe(true); expect(value.refreshCancelled).toBe(true);
  expect(value.cancellationRetainedHostBytes).toBe(true); expect(value.cancellationReleasedLock).toBe(true);
  expect(value.observedLedgerHeld).toBeGreaterThan(0); expect(value.ledgerHeld).toBe(0);
  expect(value.workerCredentialFile).toBe(false); expect(value.secretsInNativeObservation).toBe(false);
  expect(value.accounts).toEqual(Array.from({ length: 4 }, () => ({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" })));
  expect(value.copyOutRefusals, "CANCELLED_HELPER_COPYOUT_REMAINS_REFUSED").toEqual([{ name: "AbortError", signalAborted: true }]);
  expect(value.stderr).toEqual([]);
  console.log(JSON.stringify({ sdkSeparateIdentity: profile, cases: 1, workerUid: 21002, hostUid: 21001, result: "pass" }));
}
