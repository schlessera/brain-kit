/** Native protocol proof, not ordinary-worker launcher or host-filesystem isolation proof. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readlinkSync } from "node:fs";

test("installed native first-party relay preserves resumed history, per-turn model, current host login and native billing observations without worker credentials", async () => {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  const native = JSON.parse(readFileSync(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(sdkRequire.resolve("./manifest.json"), "utf8"));
  expect(native.version).toBe("0.3.293");
  expect(manifest.version).toBe("2.1.293");
  const binary = readFileSync(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude"));
  expect(createHash("sha256").update(binary).digest("hex")).toBe(manifest.platforms["linux-x64"].checksum);
  // No test fetch instrumentation covers the native executable. Its entire
  // process tree therefore runs with no external route and no ambient env.
  const fixture = new URL("./fixtures/host-relay-probe.ts", import.meta.url).pathname;
  const child = Bun.spawn(["bwrap", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--unshare-net", "--unshare-pid", "--die-with-parent",
    "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--proc", "/proc", "--dev", "/dev", process.execPath, fixture], {
    env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 25_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  expect(stderr).toBe("");
  const result = JSON.parse(stdout);
  expect(result.nativeBinaryMatches, "ACTUAL_SELECTED_NATIVE_EXECUTABLE").toBe(true);
  expect(result.namespace, "ACTUAL_PRIVATE_NATIVE_NETWORK").not.toBe(readlinkSync("/proc/self/ns/net"));
  expect(result.sessionRetained).toBe(true);
  expect(result.requests, "NATIVE_CURRENT_HOST_CREDENTIAL_AND_MODEL").toEqual([
    { credentialIndex: 0, apiKey: null, model: "claude-haiku-4-5", priorMessages: 1 },
    { credentialIndex: 1, apiKey: null, model: "claude-sonnet-4-6", priorMessages: 3 },
    { credentialIndex: 2, apiKey: null, model: "claude-haiku-4-5", priorMessages: 5 },
  ]);
  expect(result.authorities).toEqual(["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/messages",
    "https://platform.claude.com/v1/oauth/token", "https://api.anthropic.com/v1/messages", "https://platform.claude.com/v1/oauth/token"]);
  expect(result.refreshes).toBe(2);
  expect(result.hostAfterRefresh).toBe(true);
  // These are the unaugmented native initialize observations. Unix transport
  // does not report the stored account's email, organization or tier here.
  expect(result.accounts).toEqual(Array.from({ length: 4 }, () => ({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" })));
  expect(result.workerCredentialFile).toBe(false);
  expect(result.nativePlaceholder, "ACTUAL_NATIVE_PROCESS_PLACEHOLDER").toBe(true);
  expect(result.secretsInNativeObservation, "NATIVE_ENV_FILES_AND_LOGS_EXCLUDE_HOST_TOKENS").toBe(false);
  expect(result.stderr).toEqual([]);
  expect(result.refreshCancelled, "NATIVE_ABORT_CLOSES_ACTUAL_HOST_REFRESH").toBe(true);
  expect(result.cancellationRetainedHostBytes).toBe(true);
  expect(result.cancellationReleasedLock).toBe(true);
});
