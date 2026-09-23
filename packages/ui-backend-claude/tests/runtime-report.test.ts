/**
 * Each Claude turn reports the runtime that ran, the credential it selected,
 * and the billing mode that implies, checked against the PROFILE's policy
 * (#211). And an account the runtime could not use is reported as its own
 * failure class.
 */

import { describe, expect, test } from "bun:test";
import type { AccountInfo, query } from "@anthropic-ai/claude-agent-sdk";
import type { BackendActivityEvent, BackendBridge } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { MEASURED_RUNTIME } from "../src/measured-runtime";
import { defineProfiles } from "../src/profiles";
import { observedBilling } from "../src/subscription";

function queryWith(init: Record<string, unknown>, account: AccountInfo | undefined, more: unknown[] = []): typeof query {
  return (() => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1", ...init };
      yield* more;
      yield { type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
    return Object.assign(stream, { initializationResult: async () => ({ account }) });
  }) as unknown as typeof query;
}

async function turn(queryFn: typeof query, profileId?: string) {
  const activity: BackendActivityEvent[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const bridge: BackendBridge = {
    emit: () => {},
    requestPermission: async () => ({ behavior: "allow" }),
    activity: (event) => activity.push(event),
  };
  const backend = createClaudeBackend({
    brainPath: "/brain",
    queryFn,
    profiles: defineProfiles([
      { id: "claude", label: "Claude", source: "builtin" },
      { id: "bearer", label: "Bearer", authTokenEnv: "SOME_TOKEN", source: "declared" },
    ]),
    log: (level, message) => logs.push({ level, message }),
  });
  await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge, ...(profileId ? { profileId } : {}) });
  return { activity, logs };
}

const OAUTH_ACCOUNT: AccountInfo = { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" };

describe("the per-turn runtime report", () => {
  test("carries the CLI version that ran, the SDK version, and the observed subscription", async () => {
    const { activity, logs } = await turn(
      queryWith({ claude_code_version: MEASURED_RUNTIME.claudeCode, apiKeySource: "none" }, OAUTH_ACCOUNT)
    );
    const report = activity.find((e) => e.kind === "runtime_observed");
    expect(report).toEqual({
      kind: "runtime_observed",
      runtime: { name: "claude-code", version: MEASURED_RUNTIME.claudeCode },
      sdk: { name: "@anthropic-ai/claude-agent-sdk", version: MEASURED_RUNTIME.agentSdk },
      credential: { apiKeySource: "none", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" },
      billing: "subscription",
      policy: "subscription",
      measured: true,
    });
    expect(logs.filter((l) => l.level === "warn")).toEqual([]);
  });

  test("an API key under a credential-free profile is flagged against the profile's policy, whatever the classifier says", async () => {
    // Classification and the #253 env clearing are not consulted here: this
    // is the observation, so it still catches both regressing together.
    const { activity, logs } = await turn(
      queryWith({ claude_code_version: "9.9.9", apiKeySource: "ANTHROPIC_API_KEY" }, {
        ...OAUTH_ACCOUNT,
        apiKeySource: "ANTHROPIC_API_KEY",
      })
    );
    const report = activity.find((e) => e.kind === "runtime_observed") as Extract<
      BackendActivityEvent,
      { kind: "runtime_observed" }
    >;
    expect(report.billing).toBe("api");
    expect(report.policy).toBe("subscription");
    expect(report.policyViolation).toContain("API credential");
    expect(report.measured).toBe(false);
    expect(logs.filter((l) => l.level === "warn" && l.message === "billing policy violated")).toHaveLength(1);
  });

  test("a declared bearer profile's own token is api-billed, as declared, and not flagged", async () => {
    process.env.SOME_TOKEN = "bearer";
    try {
      const { activity, logs } = await turn(
        queryWith({ claude_code_version: "9.9.9", apiKeySource: "none" }, {
          tokenSource: "ANTHROPIC_AUTH_TOKEN",
          apiProvider: "firstParty",
        }),
        "bearer"
      );
      const report = activity.find((e) => e.kind === "runtime_observed") as Extract<
        BackendActivityEvent,
        { kind: "runtime_observed" }
      >;
      expect(report.billing).toBe("api");
      expect(report.policy).toBe("api");
      expect(report.policyViolation).toBeUndefined();
      expect(logs.filter((l) => l.message === "billing policy violated")).toEqual([]);
    } finally {
      delete process.env.SOME_TOKEN;
    }
  });

  for (const [observed, account, apiKeySource, reason] of [
    ["subscription", { subscriptionType: "Claude Max", apiProvider: "firstParty" }, "none", "ran on a subscription"],
    ["unknown", { apiProvider: "firstParty" }, "none", "not a recognised subscription"],
  ] as const) {
    test(`a declared API profile that ran on ${observed} is flagged too`, async () => {
      process.env.SOME_TOKEN = "bearer";
      try {
        const { activity, logs } = await turn(
          queryWith({ claude_code_version: "9.9.9", apiKeySource }, account),
          "bearer"
        );
        const report = activity.find((e) => e.kind === "runtime_observed") as Extract<
          BackendActivityEvent,
          { kind: "runtime_observed" }
        >;
        expect(report.billing).toBe(observed);
        expect(report.policy).toBe("api");
        expect(report.policyViolation).toContain("declared as API-billed");
        expect(report.policyViolation).toContain(reason);
        expect(logs.filter((l) => l.level === "warn" && l.message === "billing policy violated")).toHaveLength(1);
      } finally {
        delete process.env.SOME_TOKEN;
      }
    });
  }

  test("an account the runtime could not use is reported as its own failure class", async () => {
    const { activity } = await turn(
      queryWith({ claude_code_version: "9.9.9", apiKeySource: "none" }, OAUTH_ACCOUNT, [
        {
          type: "assistant",
          parent_tool_use_id: null,
          error: "authentication_failed",
          message: { content: [{ type: "text", text: "Failed to authenticate. API Error: 401" }] },
        },
      ])
    );
    expect(activity.filter((e) => e.kind === "auth_failure")).toEqual([
      { kind: "auth_failure", errorClass: "authentication_failed", message: "Failed to authenticate. API Error: 401" },
    ]);
  });
});

describe("a turn the subscription gate refuses (#253)", () => {
  test("still reports what the handshake said it would bill", async () => {
    // A double that pulls the prompt, as the SDK does, so the gate runs.
    const queryFn = ((params: { prompt: AsyncIterable<unknown> }) => ({
      initializationResult: async () => ({ account: { ...OAUTH_ACCOUNT, apiKeySource: "ANTHROPIC_API_KEY" } }),
      getSettings: async () => ({ effective: {}, sources: [] }),
      // oxlint-disable-next-line require-yield -- consumes the prompt only; the gate releases nothing
      async *[Symbol.asyncIterator]() {
        for await (const _ of params.prompt) {
          // nothing is released
        }
      },
    })) as unknown as typeof query;
    const { activity } = await turn(queryFn);
    const report = activity.find((e) => e.kind === "runtime_observed") as Extract<
      BackendActivityEvent,
      { kind: "runtime_observed" }
    >;
    expect(report.billing).toBe("api");
    expect(report.policyViolation).toContain("API credential");
    expect(report.runtime).toBeUndefined();
    expect(activity.some((e) => e.kind === "auth_failure" && e.errorClass === "subscription_required")).toBe(true);
  });
});

describe("observedBilling", () => {
  const rows: Array<[string, AccountInfo | undefined, string | undefined, "subscription" | "api" | "unknown"]> = [
    ["an env OAuth token", OAUTH_ACCOUNT, "none", "subscription"],
    ["an API key", { tokenSource: "none" }, "ANTHROPIC_API_KEY", "api"],
    ["both, as the raw CLI resolves them", OAUTH_ACCOUNT, "ANTHROPIC_API_KEY", "api"],
    ["neither", { tokenSource: "none" }, "none", "unknown"],
    ["a stored subscription login (no tokenSource, a tier)", { subscriptionType: "Claude Max" }, undefined, "subscription"],
    ["the CLI's fallback tier label", { subscriptionType: "Claude API" }, undefined, "unknown"],
    ["a stored Console key", OAUTH_ACCOUNT, "/login managed key", "api"],
    ["an apiKeyHelper", OAUTH_ACCOUNT, "apiKeyHelper", "api"],
    ["a declared bearer, apiKeySource none", { tokenSource: "ANTHROPIC_AUTH_TOKEN" }, "none", "api"],
    ["a declared bearer, apiKeySource omitted", { tokenSource: "ANTHROPIC_AUTH_TOKEN" }, undefined, "api"],
    [
      "a declared bearer beside a stored subscription login",
      { tokenSource: "ANTHROPIC_AUTH_TOKEN", subscriptionType: "Claude Max", apiProvider: "firstParty" },
      "none",
      "api",
    ],
    ["a third-party provider", { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "bedrock" }, undefined, "api"],
    ["no account at all", undefined, undefined, "unknown"],
  ];
  for (const [name, account, apiKeySource, expected] of rows) {
    test(name, () => {
      expect(observedBilling(account, apiKeySource)).toBe(expected);
    });
  }
});
