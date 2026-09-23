/**
 * The account check a subscription turn passes before its prompt is released
 * (#253). The live half — what the CLI actually sends — is
 * subscription-billing.test.ts; this is the table the check decides from,
 * including the shapes no keyless run can produce (a stored claude.ai login,
 * a third-party provider).
 */

import { describe, expect, test } from "bun:test";

import { subscriptionVerdict } from "../src/subscription";

describe("subscriptionVerdict", () => {
  test("an env OAuth token with no API key is a subscription", () => {
    expect(
      subscriptionVerdict({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" })
    ).toEqual({ ok: true, via: "oauth-token" });
    expect(subscriptionVerdict({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" })).toEqual({
      ok: true,
      via: "oauth-token",
    });
  });

  test("a stored claude.ai login reports a tier, not a token source", () => {
    for (const tier of ["Claude Pro", "Claude Max", "Claude Team", "Claude Enterprise"]) {
      expect(subscriptionVerdict({ subscriptionType: tier, apiProvider: "firstParty" })).toEqual({
        ok: true,
        via: "subscription-login",
      });
    }
  });

  test("the CLI's fallback tier label is not a subscription", () => {
    expect(subscriptionVerdict({ subscriptionType: "Claude API" }).ok).toBe(false);
  });

  test("any API key source is refused, even beside an OAuth token", () => {
    for (const source of ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]) {
      const verdict = subscriptionVerdict({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: source });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(source);
    }
  });

  test("an explicit apiKeySource of none is the same as an omitted one", () => {
    expect(
      subscriptionVerdict({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: "none" }).ok
    ).toBe(true);
  });

  test("a bearer token is not a subscription", () => {
    expect(subscriptionVerdict({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }).ok).toBe(false);
  });

  test("a third-party provider is refused whatever else it reports", () => {
    expect(
      subscriptionVerdict({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "bedrock" }).ok
    ).toBe(false);
  });

  test("nothing logged in, or no account at all, is refused", () => {
    expect(subscriptionVerdict({ tokenSource: "none", apiProvider: "firstParty" }).ok).toBe(false);
    expect(subscriptionVerdict({}).ok).toBe(false);
    expect(subscriptionVerdict(undefined).ok).toBe(false);
  });
});
