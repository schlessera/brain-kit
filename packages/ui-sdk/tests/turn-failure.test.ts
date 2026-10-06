// The turn-failure and retry fields (#575) are additive: a frame that carries
// them parses, keeps them, and a frame without them parses exactly as before.
// A bad value in one never costs the frame — the frame is a turn's terminal.
import { describe, expect, test } from "bun:test";

import { describeRetry } from "../src/protocol-helpers.js";
import {
  SUBSCRIPTION_AUTH_INSTRUCTIONS,
  subscriptionAuthAction,
  type ServerMessage,
} from "../src/protocol.js";
import * as server from "../src/server/index.js";
import { parseServerMessage } from "../src/schemas.js";

const parse = (frame: unknown) => parseServerMessage(JSON.stringify(frame));

const RESULT = {
  type: "result",
  sessionId: "s1",
  outcome: "error",
  durationMs: 10,
  numTurns: 1,
  isError: true,
} as const;

const FAILURE = { errorClass: "invalid_request", status: 400, message: "API Error: 400 model not supported" };

describe("the failure payload on the wire", () => {
  test("a result carrying a failure parses and keeps it", () => {
    const out = parse({ ...RESULT, failure: FAILURE });
    expect(out).toEqual({ ok: true, message: { ...RESULT, failure: FAILURE } as ServerMessage });
  });

  test("a result without one parses as it always did", () => {
    expect(parse(RESULT)).toEqual({ ok: true, message: RESULT as ServerMessage });
  });

  test("an unreadable failure is dropped, never the terminal frame", () => {
    const out = parse({ ...RESULT, failure: { status: "four hundred" } });
    expect(out.ok).toBe(true);
    if (out.ok && out.message.type === "result") {
      expect(out.message.failure).toBeUndefined();
      expect(out.message.outcome).toBe("error");
    }
  });

  test("an unknown auth action is dropped, the failure kept", () => {
    const out = parse({ ...RESULT, failure: { ...FAILURE, authAction: "call_support" } });
    expect(out.ok && out.message.type === "result" && out.message.failure).toEqual(FAILURE);
  });

  test("observed attempts and epoch-ms resets survive every failure-bearing frame", () => {
    const failure = { ...FAILURE, attempts: 2, resetsAt: 1_790_848_800_000 };
    for (const frame of [{ ...RESULT, failure }, { type: "error", code: "limit", message: "refused", failure },
      { type: "session_history", sessionId: "s1", messages: [{ role: "assistant", content: "", toolCalls: [], failure }] }]) {
      const out = parse(frame);
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error(out.error);
      const actual = out.message.type === "session_history" ? out.message.messages[0]?.failure :
        out.message.type === "result" || out.message.type === "error" ? out.message.failure : undefined;
      expect(actual).toEqual(failure);
    }
  });

  test("unreadable observations are dropped independently and keep the terminal failure", () => {
    for (const [key, values] of [["attempts", [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]],
      ["resetsAt", [-1, 1.5, "1790848800000", null, Number.MAX_SAFE_INTEGER + 1]]] as const) {
      for (const value of values) {
        const out = parse({ ...RESULT, failure: { ...FAILURE, attempts: 2, resetsAt: 1_790_848_800_000, [key]: value } });
        expect(out.ok).toBe(true);
        if (!out.ok || out.message.type !== "result") throw new Error("missing terminal");
        expect(out.message.failure?.message).toBe(FAILURE.message);
        expect(out.message.failure?.[key]).toBeUndefined();
        expect(out.message.failure?.[key === "attempts" ? "resetsAt" : "attempts"]).toBe(key === "attempts" ? 1_790_848_800_000 : 2);
      }
    }
  });

  test("a newer server's extra failure fields survive", () => {
    const out = parse({ ...RESULT, failure: { ...FAILURE, model: "some-model" } });
    const kept = out.ok && out.message.type === "result" ? (out.message.failure as unknown) : undefined;
    expect(kept).toEqual({ ...FAILURE, model: "some-model" });
  });

  test("a bare error and a replayed message carry it too", () => {
    const error = parse({ type: "error", code: "CLAUDE_AUTH", message: "refused", failure: FAILURE });
    expect(error.ok && error.message.type === "error" && error.message.failure).toEqual(FAILURE);
    const history = parse({
      type: "session_history",
      sessionId: "s1",
      messages: [{ role: "assistant", content: "", toolCalls: [], failure: FAILURE }],
    });
    expect(history.ok && history.message.type === "session_history" && history.message.messages[0]?.failure).toEqual(
      FAILURE
    );
  });

  test("a retry rides a thinking status; a bad one leaves the status intact", () => {
    const retry = { attempt: 2, maxAttempts: 10, delayMs: 5000, errorClass: "rate_limit", status: 429 };
    const good = parse({ type: "status", status: "thinking", detail: describeRetry(retry), retry });
    expect(good.ok && good.message.type === "status" && good.message.retry).toEqual(retry);
    const bad = parse({ type: "status", status: "thinking", retry: { attempt: 0 } });
    expect(bad.ok).toBe(true);
    expect(bad.ok && bad.message.type === "status" && bad.message.retry).toBeUndefined();
  });
});

describe("describeRetry", () => {
  test("says only what the runtime reported", () => {
    expect(describeRetry({ attempt: 2, maxAttempts: 10, delayMs: 5000, errorClass: "rate_limit", status: 429 })).toBe(
      "Retrying (attempt 2 of 10) in 5s after rate_limit, HTTP 429"
    );
    expect(describeRetry({ attempt: 1 })).toBe("Retrying (attempt 1)");
    expect(describeRetry({ attempt: 3, errorClass: "unknown", delayMs: 250 })).toBe("Retrying (attempt 3) in 250ms");
  });
});

describe("the subscription auth split", () => {
  test("three actions, each its own instruction", () => {
    expect(subscriptionAuthAction("authentication_failed")).toBe("relogin");
    expect(subscriptionAuthAction("oauth_org_not_allowed")).toBe("check_account");
    expect(subscriptionAuthAction("account_on_hold")).toBe("check_account");
    expect(subscriptionAuthAction("billing_error")).toBe("check_account");
    expect(subscriptionAuthAction("subscription_required")).toBe("check_config");
    expect(new Set(Object.values(SUBSCRIPTION_AUTH_INSTRUCTIONS)).size).toBe(3);
  });

  test("the server entry still exports the same values", () => {
    expect(server.subscriptionAuthAction).toBe(subscriptionAuthAction);
    expect(server.SUBSCRIPTION_AUTH_INSTRUCTIONS).toBe(SUBSCRIPTION_AUTH_INSTRUCTIONS);
  });
});
