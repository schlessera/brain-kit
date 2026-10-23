import { expect, test } from "bun:test";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../..");
function probe(fixture: string, mode?: string): Record<string, any> {
  const child = Bun.spawnSync(["bwrap", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
    "--unshare-net", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--tmpfs", "/opt", "--proc", "/proc", "--dev", "/dev",
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

test("a server-selected custom origin listed for the host login receives it through the relay", () => {
  const proof = probe("server-host-relay-probe.ts", "server-custom-listed");
  expect(proof.requests, "CUSTOM_ORIGIN_LISTED_RECEIVES_HOST_LOGIN").toEqual([{ credential: 0, model: "claude-haiku-4-5", history: 1 }]);
  expect(proof.results[0]?.outcome).toBe("success");
  expect(proof.observations.map((event: any) => [event.payload.host, event.payload.path, event.payload.inference]),
    "CUSTOM_ORIGIN_LISTED_RECORDED").toEqual([["gateway.ithaca.invalid", "/anthropic/v1/messages", true]]);
});
for (const mode of ["server-custom-unlisted", "server-custom-other-port"]) test(`a server-selected custom origin is refused before the host login when ${mode === "server-custom-unlisted" ? "nothing lists it" : "only another port is listed"}`, () => {
  const proof = probe("server-host-relay-probe.ts", mode);
  expect(proof.requests, "CUSTOM_ORIGIN_UNLISTED_NO_CREDENTIAL_FORWARDING").toEqual([]);
  expect(proof.refreshes).toBe(0);
  expect(proof.results).toHaveLength(1);
  expect(proof.results[0].failure, "CUSTOM_ORIGIN_UNLISTED_REFUSED_AT_THE_GATE").toMatchObject({ errorClass: "subscription_required",
    message: expect.stringContaining("BRAIN_UI_CLAUDE_OAUTH_ORIGINS") });
});

test("project settings may repeat the server's custom route in an equivalent spelling", () => {
  const proof = probe("server-host-relay-probe.ts", "server-custom-project-same");
  expect(proof.requests, "CUSTOM_ORIGIN_PROJECT_SAME_ROUTE_ALLOWED").toEqual([{ credential: 0, model: "claude-haiku-4-5", history: 1 }]);
});
test("project settings that move the server's custom route to another path are refused before the host login", () => {
  const proof = probe("server-host-relay-probe.ts", "server-custom-project-other");
  expect(proof.requests, "CUSTOM_ORIGIN_PROJECT_OTHER_ROUTE_NO_FORWARDING").toEqual([]);
  expect(proof.results[0]?.failure?.errorClass, "CUSTOM_ORIGIN_PROJECT_OTHER_ROUTE_REFUSED").toBe("subscription_required");
});

test("actual native inference stops when the durable egress recorder fails", () => {
  const proof = probe("server-host-relay-probe.ts", "recorder-failure");
  expect(proof.recordingFailure, "EGRESS_RECORDER_FAILURE_RETAINED").toBe(true);
  expect(proof.observations).toEqual([]);
  expect(proof.results.some((result: any) => result.outcome === "success"), "EGRESS_RECORDER_FAILURE_NO_SUCCESS").toBe(false);
});

for (const [mode, header] of [["api-key", "apiKey"], ["api-token", "authorization"]] as const) test(`an API-billed profile's ${mode === "api-key" ? "key" : "bearer token"} stays on the host: the relay sends it and the native worker holds a placeholder`, () => {
  const proof = probe("server-host-relay-probe.ts", mode);
  expect(proof.results[0]?.outcome).toBe("success");
  expect(proof.apiRequests, "API_PROFILE_RELAY_INJECTS_HOST_CREDENTIAL").toEqual([header === "apiKey"
    ? { apiKey: "odysseus-api-secret-for-ithaca", authorization: null }
    : { apiKey: null, authorization: "Bearer odysseus-api-secret-for-ithaca" }]);
  expect(proof.nativeEnvironmentCount, "API_PROFILE_NATIVE_ENVIRONMENT_OBSERVED").toBe(1);
  expect(proof.secretInWorker, "API_PROFILE_WORKER_HOLDS_NO_CREDENTIAL").toBe(false);
  // The brain CLI's keys are withheld by name, so its commands can say which provider is missing (#1666).
  expect(proof.withheldKeys, "API_PROFILE_WORKER_NAMES_WITHHELD_KEYS").toEqual([header === "apiKey"
    ? "ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN,GEMINI_API_KEY,OPENROUTER_API_KEY,TYPESAFE_API_KEY"
    : "CLAUDE_CODE_OAUTH_TOKEN,GEMINI_API_KEY,OPENROUTER_API_KEY,TYPESAFE_API_KEY"]);
  expect(proof.workerPlaceholders, "API_PROFILE_WORKER_PLACEHOLDERS").toEqual([header === "apiKey"
    ? ["brain-inference-relay-placeholder", "", "", null] : ["", "brain-inference-relay-placeholder", "", null]]);
  expect(proof.observations.map((event: any) => [event.payload.host, event.payload.path, event.payload.inference, event.payload.outcome]),
    "API_PROFILE_RELAY_RECORDED").toEqual([["api.anthropic.com", "/v1/messages", true, "completed"]]);
});

test("an API-billed profile whose project settings move its route is refused before its key is sent", () => {
  const proof = probe("server-host-relay-probe.ts", "api-key-project-custom");
  expect(proof.apiRequests, "API_PROFILE_CHANGED_ROUTE_NO_CREDENTIAL_FORWARDING").toEqual([]);
  expect(proof.results).toHaveLength(1);
  expect(proof.results[0].failure, "API_PROFILE_CHANGED_ROUTE_REFUSED").toMatchObject({ errorClass: "auth_failure",
    message: expect.stringContaining("Claude inference transport refused") });
});

test("the host's stored login outside every host mask is masked in the worker", () => {
  const proof = probe("server-host-relay-probe.ts", "outside-masks");
  expect(proof.requests, "OUTSIDE_MASKS_HOST_LOGIN_STILL_RELAYED").toEqual([{ credential: 0, model: "claude-haiku-4-5", history: 1 }]);
  expect(proof.controlVisible, "OUTSIDE_MASKS_WORKER_VIEW_OBSERVED").toBe(true);
  expect(proof.hostLoginVisible, "OUTSIDE_MASKS_HOST_LOGIN_MASKED").toBe(false);
});

for (const [mode, reason] of [["api-key-project-credential", "projectSettings set ANTHROPIC_API_KEY"],
  ["login-in-brain", "the host's Claude login is inside the brain"]] as const) test(`${mode} is refused before the prompt is sent`, () => {
  const proof = probe("server-host-relay-probe.ts", mode);
  expect(proof.requests, "RELAY_REFUSAL_SENDS_NOTHING").toEqual([]);
  expect(proof.apiRequests).toEqual([]);
  expect(proof.results[0]?.failure?.message, "RELAY_REFUSAL_NAMES_ITS_REASON").toContain(reason);
});
