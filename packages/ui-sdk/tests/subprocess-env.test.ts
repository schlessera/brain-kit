import { describe, expect, test } from "bun:test";

import { SUBPROCESS_ENV, filterSubprocessEnv } from "../src/server";

describe("subprocess environment descriptor", () => {
  test("denylist filtering strips no-audience entries and preserves known and unknown variables", () => {
    const serverOnly = [
      "COOKIE_SECRET",
      "BRAIN_UI_PASSWORD_HASH",
      "DEEPGRAM_API_KEY",
      "BRAIN_UI_SKILLS_GITHUB_TOKEN",
      "WEBAUTHN_RP_NAME",
      "WEBAUTHN_USER_NAME",
      "WEBAUTHN_USER_ID",
      "WEBAUTHN_RP_ID",
      "WEBAUTHN_ORIGINS",
      "BRAIN_UI_ALLOW_LOOPBACK_ORIGIN",
      "TRUST_PROXY",
      "TRUST_PROXY_HOPS",
      "PROXY_AUTH_HEADER",
      "ALLOWED_ORIGINS",
      "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH",
      "BRAIN_UI_ALLOW_PASSWORD",
    ] as const;
    for (const name of serverOnly) {
      expect(SUBPROCESS_ENV[name]).toEqual([]);
    }
    expect(SUBPROCESS_ENV.CLAUDE_CODE_OAUTH_TOKEN).toContain("agent");

    const filtered = filterSubprocessEnv({
      ...Object.fromEntries(serverOnly.map((name) => [name, "server-only-test-value"])),
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-token",
      GITHUB_TOKEN: "github-test-token",
      BRAIN_UI_SYNC_GITHUB_TOKEN: "sync-test-token",
      NODE_ENV: "production",
      FUTURE_OPERATOR_VARIABLE: "unknown-test-value",
    });

    for (const name of serverOnly) {
      expect(filtered[name]).toBeUndefined();
    }
    expect(filtered).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-token",
      GITHUB_TOKEN: "github-test-token",
      BRAIN_UI_SYNC_GITHUB_TOKEN: "sync-test-token",
      NODE_ENV: "production",
      FUTURE_OPERATOR_VARIABLE: "unknown-test-value",
    });
  });
});
