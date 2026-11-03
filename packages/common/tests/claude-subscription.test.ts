import { describe, expect, test } from "bun:test";
import {
  CLEARED_API_CREDENTIALS,
  NEUTRALISED_SETTINGS,
  settingsRefusal,
  subscriptionVerdict,
  type CliSettingsReport,
} from "../src/claude-subscription";

// Written out, not read from the table: a variable dropped from
// CLEARED_API_CREDENTIALS must fail here rather than shrink the loop.
const CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "ANTHROPIC_UNIX_SOCKET",
] as const;

/** A report with `settings` in one named source and nothing else. */
function inSource(settings: Record<string, unknown>, source = "projectSettings"): CliSettingsReport {
  return { effective: {}, sources: [{ source: "userSettings", settings: {} }, { source, settings }] };
}

describe("the cleared credential table", () => {
  test("clears every credential and routing variable, each to the empty value", () => {
    expect(Object.keys(CLEARED_API_CREDENTIALS).sort()).toEqual([...CREDENTIAL_VARIABLES].sort());
    for (const key of CREDENTIAL_VARIABLES) expect(CLEARED_API_CREDENTIALS[key]).toBe("");
    expect(Object.isFrozen(CLEARED_API_CREDENTIALS)).toBe(true);
  });

  test("the neutralised flag settings switch the helper off and clear the same variables", () => {
    expect(NEUTRALISED_SETTINGS).toEqual({ apiKeyHelper: "", env: CLEARED_API_CREDENTIALS });
    expect(settingsRefusal({ effective: NEUTRALISED_SETTINGS, sources: [{ source: "flagSettings", settings: NEUTRALISED_SETTINGS }] }))
      .toBeNull();
  });
});

describe("settingsRefusal", () => {
  for (const key of CREDENTIAL_VARIABLES) {
    test(`${key} set in a settings source is refused`, () => {
      expect(settingsRefusal(inSource({ env: { [key]: "1" } }))).toBe(`projectSettings set ${key}`);
      expect(settingsRefusal({ effective: { env: { [key]: "1" } } })).toBe(`effective settings set ${key}`);
    });
  }

  test("a pinned value is accepted only when it matches exactly", () => {
    const pinned = { ANTHROPIC_UNIX_SOCKET: "/run/relay.sock" };
    expect(settingsRefusal(inSource({ env: { ANTHROPIC_UNIX_SOCKET: "/run/relay.sock" } }), pinned)).toBeNull();
    expect(settingsRefusal(inSource({ env: { ANTHROPIC_UNIX_SOCKET: "/run/relay.sock " } }), pinned))
      .toBe("projectSettings set ANTHROPIC_UNIX_SOCKET");
    expect(settingsRefusal(inSource({ env: { ANTHROPIC_UNIX_SOCKET: "/run/other.sock" } }), pinned))
      .toBe("projectSettings set ANTHROPIC_UNIX_SOCKET");
    // A pin covers its own variable, not its neighbours.
    expect(settingsRefusal(inSource({ env: { ANTHROPIC_API_KEY: "/run/relay.sock" } }), pinned))
      .toBe("projectSettings set ANTHROPIC_API_KEY");
  });

  test("an apiKeyHelper or policyHelper in any layer is refused", () => {
    for (const source of ["userSettings", "projectSettings", "localSettings", "flagSettings", "policySettings"]) {
      expect(settingsRefusal(inSource({ apiKeyHelper: "print-key" }, source))).toBe(`${source} configure an apiKeyHelper`);
      expect(settingsRefusal(inSource({ policyHelper: "policy" }, source))).toBe(`${source} configure a policyHelper`);
      expect(settingsRefusal(inSource({ policyHelpers: [] }, source))).toBe(`${source} configure a policyHelper`);
    }
    expect(settingsRefusal({ effective: { apiKeyHelper: "print-key" } })).toBe("effective settings configure an apiKeyHelper");
    expect(settingsRefusal({ effective: { policyHelper: {} } })).toBe("effective settings configure a policyHelper");
    expect(settingsRefusal({ sources: [{ settings: { apiKeyHelper: "x" } }] })).toBe("a settings source configure an apiKeyHelper");
  });

  test("empty or blank values are the CLI's none, and no report is refused rather than trusted", () => {
    expect(settingsRefusal(inSource({ apiKeyHelper: "  ", env: { ANTHROPIC_API_KEY: " " } }))).toBeNull();
    expect(settingsRefusal(undefined)).toBe("the CLI did not report its settings");
  });
});

describe("subscriptionVerdict", () => {
  test("an env OAuth token or a known tier is a subscription", () => {
    expect(subscriptionVerdict({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: "none" })).toEqual({ ok: true, via: "oauth-token" });
    expect(subscriptionVerdict({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" })).toEqual({ ok: true, via: "oauth-token" });
    for (const tier of ["Claude Pro", "Claude Max", "Claude Team", "Claude Enterprise"]) {
      expect(subscriptionVerdict({ subscriptionType: tier })).toEqual({ ok: true, via: "subscription-login" });
    }
  });

  test("an API key, a third-party provider, the fallback tier or no account is refused", () => {
    expect(subscriptionVerdict({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: "ANTHROPIC_API_KEY" }))
      .toEqual({ ok: false, reason: "the CLI selected an API key (ANTHROPIC_API_KEY)" });
    expect(subscriptionVerdict({ subscriptionType: "Claude Max", apiProvider: "bedrock" }))
      .toEqual({ ok: false, reason: "the CLI is set to the bedrock provider" });
    expect(subscriptionVerdict({ subscriptionType: "Claude API" })).toEqual({ ok: false, reason: "no Claude subscription is logged in" });
    expect(subscriptionVerdict({ tokenSource: "ANTHROPIC_AUTH_TOKEN" })).toEqual({ ok: false, reason: "no Claude subscription is logged in" });
    expect(subscriptionVerdict(undefined)).toEqual({ ok: false, reason: "the CLI reported no account" });
  });
});
