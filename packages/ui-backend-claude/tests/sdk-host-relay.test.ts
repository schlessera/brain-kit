/** Full SDK construction, native startup and prepared ordinary transport; fixture storage is not Btrfs qualification. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readlinkSync } from "node:fs";

test.each(["strict", "governed"] as const)("prepared %s SDK turn preserves native history, MCP tools, system context, host OAuth and cancellation", async profile => {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  const native = JSON.parse(readFileSync(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(sdkRequire.resolve("./manifest.json"), "utf8"));
  expect(native.version).toBe("0.3.293");
  expect(manifest.version).toBe("2.1.293");
  const binary = readFileSync(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude"));
  expect(createHash("sha256").update(binary).digest("hex")).toBe(manifest.platforms["linux-x64"].checksum);
  // No test fetch instrumentation covers the native executable. Its entire
  // process tree therefore runs with no external route and no ambient env.
  const fixture = new URL("./fixtures/sdk-host-relay-probe.ts", import.meta.url).pathname;
  const child = Bun.spawn(["bwrap", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--unshare-net", "--unshare-pid", "--die-with-parent",
    "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--proc", "/proc", "--dev", "/dev", process.execPath, fixture, profile], {
    env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 25_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  // The installed SDK reports its existing canUseTool/allowedTools warning;
  // the actual every-call PreToolUse guard remains part of this assembly.
  const diagnosticLines = stderr.split("\n").filter(Boolean);
  expect(diagnosticLines.every(line => line.includes("[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]")
    || line.startsWith("(Use `bun --trace-warnings")), stderr).toBe(true);
  const result = JSON.parse(stdout);
  expect(result.nativeBinaryMatches, "ACTUAL_SELECTED_NATIVE_EXECUTABLE").toBe(true);
  expect(result.namespace, "ACTUAL_PRIVATE_NATIVE_NETWORK").not.toBe(readlinkSync("/proc/self/ns/net"));
  expect(result.sessionRetained).toBe(true);
  expect(result.profile).toBe(profile);
  expect(result.observedLedgerHeld, "FULL_SDK_ACTUAL_STATE_LEDGER_ADMITTED").toBeGreaterThan(0);
  expect(result.ledgerHeld, "ORDINARY_NATIVE_LIFETIME_RELEASES_RESERVATIONS").toBe(0);
  expect(result.requests.map(({ credentialIndex, apiKey, model, priorMessages }: {
    credentialIndex: number; apiKey: string | null; model: string; priorMessages: number;
  }) => ({ credentialIndex, apiKey, model, priorMessages })), "NATIVE_CURRENT_HOST_CREDENTIAL_AND_MODEL").toEqual([
    { credentialIndex: 0, apiKey: null, model: "claude-haiku-4-5", priorMessages: 1 },
    { credentialIndex: 1, apiKey: null, model: "claude-sonnet-4-6", priorMessages: 3 },
    { credentialIndex: 2, apiKey: null, model: "claude-haiku-4-5", priorMessages: 5 },
  ]);
  for (const request of result.requests) {
    expect(request.toolNames, "FULL_SDK_NATIVE_MCP_TOOL_ROSTER").toContain("mcp__brain-ui__show_block");
    expect(request.toolNames).toContain("mcp__brain-ui__turn_temp");
    expect(request.toolNames).toContain("Bash");
    expect(request.systemPresent, "FULL_SDK_NATIVE_SYSTEM_PRESENT").toBe(true);
    expect(request.contextPreparedProxy, "FULL_SDK_NATIVE_CONTEXT_REPORTS_SELECTED_PROXY").toBe(true);
  }
  expect(result.authorities).toEqual(["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/messages",
    "https://platform.claude.com/v1/oauth/token", "https://api.anthropic.com/v1/messages", "https://platform.claude.com/v1/oauth/token"]);
  expect(result.refreshes).toBe(2);
  expect(result.egressRecords, "NATIVE_DISPATCH_USES_CONCRETE_FIRST_PARTY_ADMISSION").toHaveLength(4);
  expect(result.egressRecords.map((record: { outcome: string }) => record.outcome)).toEqual(["completed", "completed", "completed", "cancelled"]);
  for (const record of result.egressRecords) {
    expect(record).toMatchObject({ inference: true, host: "api.anthropic.com", port: 443, path: "/v1/messages", accounting: "http_wire_bound" });
  }
  expect(result.egressBytes, "NATIVE_REQUEST_AND_RESPONSE_CHARGED").toBeGreaterThan(6000);
  expect(result.egressBytes).toBe(result.egressRecords.reduce((sum: number, record: { bytes: number }) => sum + record.bytes, 0));
  expect(result.egressBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.hostAfterRefresh).toBe(true);
  // These are the unaugmented native initialize observations. Unix transport
  // does not report the stored account's email, organization or tier here.
  expect(result.accounts).toEqual(Array.from({ length: 4 }, () => ({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" })));
  expect(result.workerCredentialFile, "ORDINARY_SPAWN_NEVER_PROJECTS_HOST_CREDENTIAL_STORE").toBe(false);
  expect(result.nativePlaceholder, "ACTUAL_NATIVE_PROCESS_PLACEHOLDER").toBe(true);
  expect(result.secretsInNativeObservation, "NATIVE_ENV_FILES_AND_LOGS_EXCLUDE_HOST_TOKENS").toBe(false);
  expect(result.stderr).toEqual([]);
  expect(result.refreshCancelled, "NATIVE_ABORT_CLOSES_ACTUAL_HOST_REFRESH").toBe(true);
  expect(result.cancellationRetainedHostBytes).toBe(true);
  expect(result.cancellationReleasedLock).toBe(true);
});


test("prepared SDK native auto-allowed Bash still honors the existing per-use refusal", async () => {
  const fixture = new URL("./fixtures/sdk-host-relay-probe.ts", import.meta.url).pathname;
  const child = Bun.spawn(["bwrap", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--unshare-net", "--unshare-pid", "--die-with-parent",
    "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--proc", "/proc", "--dev", "/dev", process.execPath, fixture, "governed", "permission"], {
    env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 25_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect({ approvals: result.permissionRequests, fileCreated: result.deniedFileExists },
    "FULL_SDK_NATIVE_REFUSAL_PREVENTS_COMMAND").toEqual({ approvals: 1, fileCreated: false });
  expect(result.requests).toHaveLength(2);
  expect(result.workerCredentialFile).toBe(false);
  expect(result.secretsInNativeObservation).toBe(false);
  expect(result.observedLedgerHeld).toBeGreaterThan(0);
  expect(result.ledgerHeld).toBe(0);
});


test.each(["managed", "project"] as const)("prepared SDK %s credential or transport override withholds the native prompt", async source => {
  const fixture = new URL("./fixtures/sdk-host-relay-probe.ts", import.meta.url).pathname;
  const child = Bun.spawn(["bwrap", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--unshare-net", "--unshare-pid", "--die-with-parent",
    "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--proc", "/proc", "--dev", "/dev", process.execPath, fixture, "governed", source], {
    env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 25_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.withheldForSettings, "FULL_SDK_NATIVE_SETTINGS_OVERRIDE_WITHHOLDS_PROMPT").toBe(true);
  expect(result.requests, "FULL_SDK_REFUSED_SETTINGS_NO_PROVIDER_CONTACT").toEqual([]);
  expect(result.authorities, "FULL_SDK_REFUSED_SETTINGS_NO_CREDENTIAL_READ_OR_REFRESH").toEqual([]);
  expect(result.workerCredentialFile).toBe(false);
  expect(result.ledgerHeld).toBe(0);
});


test("prepared SDK initializes with no projected host credential store before any prompt", async () => {
  const fixture = new URL("./fixtures/sdk-host-relay-probe.ts", import.meta.url).pathname;
  const child = Bun.spawn(["bwrap", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--unshare-net", "--unshare-pid", "--die-with-parent",
    "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--proc", "/proc", "--dev", "/dev", process.execPath, fixture, "governed", "inspect"], {
    env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 25_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.workerCredentialFile, "FULL_SDK_PREPROMPT_OMITS_HOST_CREDENTIAL_STORE").toBe(false);
  expect(result.secretsInNativeObservation, "FULL_SDK_PREPROMPT_OMITS_HOST_ENV_CREDENTIALS").toBe(false);
  expect(result.requests).toEqual([]);
  expect(result.authorities).toEqual([]);
  expect(result.observedLedgerHeld).toBeGreaterThan(0);
  expect(result.ledgerHeld).toBe(0);
});
