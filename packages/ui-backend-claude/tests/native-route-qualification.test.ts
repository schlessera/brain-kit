import { expect, test } from "bun:test";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../..");
function probe(fixture: string, mode?: string): Record<string, any> {
  const child = Bun.spawnSync(["bwrap", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
    "--unshare-net", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--proc", "/proc", "--dev", "/dev",
    process.execPath, "--preload", resolve(root, "scripts/test-network-child-preload.ts"), resolve(import.meta.dir, "fixtures", fixture), ...(mode ? [mode] : [])],
  { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 25000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
}
test("native startup route guard observes exact settings, ancestors, aliases, watch loss and overflow", () => {
  expect(probe("native-route-inputs-probe.ts").checks).toEqual([
    "UNRELATED_NATIVE_STARTUP_ALLOWED", "PROJECT_SETTINGS_ABA_REFUSED", "PROJECT_PARENT_ABA_REFUSED", "BRAIN_ANCESTOR_ABA_REFUSED",
    "MANAGED_SETTINGS_ABA_REFUSED", "MANAGED_FRAGMENT_ABA_REFUSED", "MANAGED_PARENT_ABA_REFUSED", "WATCH_LOSS_REFUSED",
    "PROJECT_ALIAS_REFUSED", "MANAGED_ALIAS_REFUSED", "OVERFLOW_REFUSED",
  ]);
});
test("unavailable native guard library leaves inactive imports working and refuses selected transport", () => {
  expect(probe("native-route-unavailable-probe.ts")).toEqual({ inactiveImport: true, selectedRefused: true });
});
test("actual ordinary runner preserves stored-login rotation, resume/model/history and persisted egress", () => {
  const proof = probe("server-host-relay-probe.ts");
  expect(proof.requests, "ACTUAL_SERVER_NATIVE_CREDENTIAL_MODEL_HISTORY").toEqual([
    { credential: 0, model: "claude-haiku-4-5", history: 1 }, { credential: 1, model: "claude-sonnet-4-6", history: 3 },
    { credential: 2, model: "claude-haiku-4-5", history: 5 },
  ]);
  expect(proof.refreshes).toBe(1);
  expect(proof.projectedCredentials, "ACTUAL_SERVER_NO_WORKER_CREDENTIAL_STORE").toBe(false);
  expect(proof.results).toHaveLength(3);
  expect(proof.results.every((result: any) => result.outcome === "success" && result.sessionId === proof.sessionId)).toBe(true);
  expect(proof.observations).toHaveLength(3);
  expect(proof.observations.every((event: any) => event.sessionId === proof.sessionId
    && event.payload.host === "api.anthropic.com" && event.payload.inference === true && event.payload.bytes > 0 && event.payload.outcome === "completed")).toBe(true);
});
for (const mode of ["project-aba", "project-custom", "managed-aba", "managed-custom"]) test(`actual native runner refuses ${mode} before prompt or host credentials`, () => {
  const proof = probe("server-host-relay-probe.ts", mode);
  expect(proof.requests, "ACTUAL_NATIVE_CHANGED_ROUTE_NO_CREDENTIAL_FORWARDING").toEqual([]);
  expect(proof.refreshes).toBe(0);
  expect(proof.results).toHaveLength(1);
  expect(proof.results[0].failure?.errorClass, "ACTUAL_NATIVE_CHANGED_ROUTE_REFUSAL").toBe("subscription_required");
});

test("actual native inference stops when the durable egress recorder fails", () => {
  const proof = probe("server-host-relay-probe.ts", "recorder-failure");
  expect(proof.recordingFailure, "EGRESS_RECORDER_FAILURE_RETAINED").toBe(true);
  expect(proof.observations).toEqual([]);
  expect(proof.results.some((result: any) => result.outcome === "success"), "EGRESS_RECORDER_FAILURE_NO_SUCCESS").toBe(false);
});
