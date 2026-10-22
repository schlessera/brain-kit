/** Native compatibility receipts; ordinary credential-free worker activation is not qualified here. */
import { expect, test } from "bun:test";
import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function nativeFixture(name: string, ...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "odysseus-pi-native-qualification-"));
  try {
    // Native libraries and credential commands are not covered by Bun's fetch
    // preload. Deny external routing to the entire process tree, clear ambient
    // credentials, and drop the capabilities used only to enable loopback.
    const child = Bun.spawn(
      [
        "unshare",
        "--user",
        "--map-current-user",
        "--keep-caps",
        "--net",
        "sh",
        "-c",
        'ip link set lo up && exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"',
        "odysseus-pi-native",
        process.execPath,
        new URL(`./fixtures/${name}.ts`, import.meta.url).pathname,
        ...args,
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          LANG: "C.UTF-8",
          TZ: "UTC",
          BUN_OPTIONS: "--no-env-file",
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: join(home, "agent"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 45_000,
      }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr || stdout).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result.namespace, "NATIVE_AUTH_PRIVATE_NETWORK_NAMESPACE").not.toBe(
      readlinkSync("/proc/self/ns/net")
    );
    return result;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("installed native auth reads current credentials, serializes refresh, cancels and redacts failures", async () => {
  const result = await nativeFixture("native-host-auth-probe");
  expect(
    result.changedStoredCredential.freshRead,
    "NATIVE_CURRENT_STORED_KEY"
  ).toBe(true);
  expect(result.nativeRefresh).toEqual({
    concurrentCalls: 2,
    refreshes: 1,
    persistedRotation: true,
  });
  expect(result.cancellation).toEqual({
    refused: true,
    hostAuthUnchanged: true,
  });
  expect(result.nativeAuthErrorRedaction).toEqual({
    status: 503,
    secretAbsent: true,
    namedRefusal: true,
  });
  expect(result.nativeOAuthEndpoint.authenticationBaseUrl).toBe(
    "https://api.individual.githubcopilot.com"
  );
  expect(result.codexRequest).toMatchObject({
    nativeAccount: "odysseus-account",
    plainPlaceholderRejectedBeforeDispatch: true,
    fixtureHTTP400: true,
  });
  // This is native routing evidence, not authority for a future host-held key.
  expect(result.customOrigin).toMatchObject({
    authBaseUrl: null,
    configAliasIntoFixtureBrain: true,
    actualRequest: {
      url: "http://127.0.0.1:1/odysseus-custom/codex/responses",
      bearer: true,
    },
    fixtureHTTP400: true,
  });
}, 60_000);

for (const mode of ["sse", "websocket", "relay"] as const) {
  test(`native ${mode} retains fresh, resident and persisted-resume account/model/usage truth`, async () => {
    const result = await nativeFixture("native-host-auth-session-probe", mode);
    expect(result.nativeSdkOnly).toBe(true);
    expect(result.persistedResume).toBe(true);
    expect(result.sessionStable).toBe(true);
    expect(
      result.requestAccounts,
      "NATIVE_AUTH_RESOLVED_EVERY_DISPATCH"
    ).toEqual([
      "odysseus-account-one",
      "odysseus-account-two",
      "odysseus-account-three",
    ]);
    expect(result.paths).toEqual(Array(3).fill("/backend-api/codex/responses"));
    expect(result.provider).toBe("openai-codex");
    expect(result.model).toBe("gpt-5.3-codex-spark");
    expect(result.api).toBe("openai-codex-responses");
    expect(result.inputLengths, "NATIVE_RESUME_RETAINS_ACTUAL_HISTORY").toEqual(
      [1, 3, 5]
    );
    expect(result.usage).toMatchObject({
      input: 5,
      output: 3,
      cacheRead: 2,
      totalTokens: 10,
    });
    expect(result.usage.cost.total).toBeGreaterThan(0);
    if (mode === "relay") {
      expect(result.relayEvents).toEqual([
        {
          method: "GET",
          path: "/backend-api/codex/responses",
          outcome: "refused",
          status: 405,
          reason: "Only inference requests are relayed",
        },
        ...Array.from({ length: 3 }, () => ({
          method: "POST",
          path: "/backend-api/codex/responses",
          outcome: "forwarded",
          status: 200,
        })),
      ]);
      expect(
        result.requestCredentials,
        "HOST_BOUND_HEADER_REPLACES_WORKER_CREDENTIALS"
      ).toEqual(
        Array.from({ length: 3 }, () => ({
          hostAuthorization: true,
          workerKey: null,
        }))
      );
      expect(result.zstdSSE).toBe(true);
    } else if (mode === "sse") expect(result.zstdSSE).toBe(true);
  }, 60_000);
}

test("native credential commands and refresh stay inside read-only-home maintenance with scratch/CAS", async () => {
  const result = await nativeFixture("native-host-auth-maintenance-probe");
  expect(result.copiedStartupTestFixture).toBe(true);
  expect(result.maintenanceNativeAuth).toEqual({
    commandKey: "odysseus-command-key",
    commandHeader: "readonly",
    refreshes: 1,
    refreshed: true,
    scratchRotation: "odysseus-refresh-two",
    hostUnchanged: true,
    directHostAuthRefused: true,
  });
  expect(result.hostFilesystemGuardPreserved).toBe(true);
  expect(result.existingCredentialExclusionHeld).toBe(true);
  expect(result.hostRefreshWritebackViaExistingCAS).toBe(true);
}, 60_000);
