// A turn that ended on an API error replays as a failure on its assistant
// message, not as prose (#575). The transcript is read through the real
// `buildSessionHistory`, fed what the SDK's transcript reader returns: the
// entry's `message` only, its `isApiErrorMessage` and `error` fields dropped.
import { describe, expect, test } from "bun:test";
import type { getSessionMessages, SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { USAGE_LIMIT_ERROR_PREFIXES, USAGE_WARNING_PREFIXES, USAGE_TRANSITION_PREFIXES, ORG_POLICY_LIMIT_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import { USAGE_LIMIT_PREFIXES } from "../src/usage-limit";
import { buildSessionHistory } from "../src/history";
import {
  INVALID_TOKEN_TEXT,
  NOT_LOGGED_IN_TEXT,
  OVERLOADED_TEXT,
  PARTIAL_ANSWER,
  SESSION,
  UNSUPPORTED_MODEL_TEXT,
  answerEntry,
  syntheticEntry,
  userTurn,
} from "./fixtures/api-failures";

const read = (entries: SessionMessage[]) =>
  buildSessionHistory(SESSION, (async () => entries) as unknown as typeof getSessionMessages, import.meta.dir);

describe("an API error replays as the turn's failure", () => {
  test("the unsupported-model turn: an empty answer that failed, with the status its text states", async () => {
    const history = await read([userTurn("Test"), syntheticEntry(UNSUPPORTED_MODEL_TEXT)]);
    expect(history).toEqual([
      { role: "user", content: "Test", toolCalls: [] },
      {
        role: "assistant",
        content: "",
        toolCalls: [],
        parts: [],
        // The transcript keeps no class, so none is claimed.
        failure: { errorClass: "unknown", status: 400, message: UNSUPPORTED_MODEL_TEXT },
      },
    ]);
  });

  test("a partial answer stays the content, and the failure lands on the same message", async () => {
    const history = await read([userTurn("Find it"), answerEntry(PARTIAL_ANSWER), syntheticEntry(OVERLOADED_TEXT)]);
    expect(history).toHaveLength(2);
    const answer = history[1]!;
    expect(answer.content).toBe(PARTIAL_ANSWER);
    expect(answer.parts).toEqual([{ kind: "text", text: PARTIAL_ANSWER }]);
    expect(answer.failure).toEqual({ errorClass: "unknown", message: OVERLOADED_TEXT });
  });

  test("the subscription's auth failures keep the relogin instruction", async () => {
    const [, invalid] = await read([userTurn("hi"), syntheticEntry(INVALID_TOKEN_TEXT)]);
    expect(invalid!.failure).toEqual({
      errorClass: "authentication_failed",
      status: 401,
      message: INVALID_TOKEN_TEXT,
      authAction: "relogin",
    });
    const [, missing] = await read([userTurn("hi"), syntheticEntry(NOT_LOGGED_IN_TEXT)]);
    expect(missing!.failure).toEqual({
      errorClass: "authentication_failed",
      message: NOT_LOGGED_IN_TEXT,
      authAction: "relogin",
    });
  });

  test("a rejected API key is an auth failure without the subscription's instruction", async () => {
    const [, keyed] = await read([userTurn("hi"), syntheticEntry("Invalid API key · Fix external API key")]);
    expect(keyed!.failure).toEqual({
      errorClass: "authentication_failed",
      message: "Invalid API key · Fix external API key",
    });
  });

  test("a synthetic weekly usage-limit stop replays as a rate_limit failure", async () => {
    const text = "You've hit your weekly limit · resets July 12";
    const [, message] = await read([userTurn("Continue the plan"), syntheticEntry(text)]);
    expect(message!.failure).toEqual({ errorClass: "rate_limit", message: text });
    expect(message!.content).toBe("");
    expect(message!.parts).toEqual([]);
  });

  test("vendored usage-limit prefixes match the installed SDK and all replay as failures", async () => {
    expect(USAGE_LIMIT_PREFIXES).toEqual(USAGE_LIMIT_ERROR_PREFIXES);
    for (const prefix of USAGE_LIMIT_PREFIXES) {
      const [, message] = await read([userTurn("Continue"), syntheticEntry(prefix)]);
      expect(message!.failure).toEqual({ errorClass: "rate_limit", message: prefix });
      expect(message!.content).toBe("");
      const [, answer] = await read([userTurn("Explain"), answerEntry(prefix)]);
      expect(answer!.failure).toBeUndefined();
      expect(answer!.content).toBe(prefix);
    }
  });

  test("usage warnings, transitions and org-policy notices remain text", async () => {
    for (const text of [...USAGE_WARNING_PREFIXES, ...USAGE_TRANSITION_PREFIXES, ...ORG_POLICY_LIMIT_PREFIXES]) {
      const [, message] = await read([userTurn("Continue"), syntheticEntry(text)]);
      expect(message!.failure).toBeUndefined();
      expect(message!.content).toBe(text);
    }
  });

  // #3356: what the runtime writes when a turn stopped is a status for that
  // turn, never the agent's words, and only an aborted request names a cause.
  test("the runtime's stop notices replay as a runtime notice, not as the agent's text", async () => {
    for (const [text, cause] of [["No response requested.", "unspecified"], ["API Error: Request was aborted.", "aborted"]] as const) {
      const [, message] = await read([userTurn("hi"), syntheticEntry(text)]);
      expect(message!.failure).toBeUndefined();
      expect(message!.content).toBe("");
      expect(message!.parts).toEqual([]);
      expect(message!.runtimeNotice).toEqual({ cause, message: text });
    }
  });

  test("a stop notice after a partial answer keeps that answer and lands on its message", async () => {
    const history = await read([userTurn("Find it"), answerEntry(PARTIAL_ANSWER), syntheticEntry("No response requested.")]);
    expect(history).toHaveLength(2);
    expect(history[1]!.content).toBe(PARTIAL_ANSWER);
    expect(history[1]!.parts).toEqual([{ kind: "text", text: PARTIAL_ANSWER }]);
    expect(history[1]!.runtimeNotice).toEqual({ cause: "unspecified", message: "No response requested." });
  });

  test("the same stop observed again is one notice, and a failure stays the fuller account", async () => {
    const repeated = await read([userTurn("hi"), syntheticEntry("No response requested."), syntheticEntry("No response requested.")]);
    expect(repeated).toHaveLength(2);
    expect(repeated[1]!.content).toBe("");
    expect(repeated[1]!.runtimeNotice).toEqual({ cause: "unspecified", message: "No response requested." });
    const failed = await read([userTurn("hi"), syntheticEntry(OVERLOADED_TEXT), syntheticEntry("No response requested.")]);
    expect(failed).toHaveLength(2);
    expect(failed[1]!.failure).toEqual({ errorClass: "unknown", message: OVERLOADED_TEXT });
    expect(failed[1]!.runtimeNotice).toBeUndefined();
  });

  test("the model or the user quoting a stop notice is their own text", async () => {
    for (const text of ["No response requested.", "API Error: Request was aborted."]) {
      const [user, answer] = await read([userTurn(text), answerEntry(text)]);
      expect(user!.content).toBe(text);
      expect(answer!.content).toBe(text);
      expect(answer!.runtimeNotice).toBeUndefined();
    }
  });

  test("a 499 cancelled request stays a classified failure, not a notice", async () => {
    const text = "API Error: 499 Inference request cancelled";
    const [, message] = await read([userTurn("hi"), syntheticEntry(text)]);
    expect(message!.failure).toEqual({ errorClass: "unknown", status: 499, message: text });
    expect(message!.runtimeNotice).toBeUndefined();
    expect(message!.content).toBe("");
  });

  test("a model's answer that talks about an API error is not a failure", async () => {
    const [, message] = await read([userTurn("What does 400 mean?"), answerEntry("API Error: 400 means a bad request.")]);
    expect(message!.failure).toBeUndefined();
    expect(message!.content).toBe("API Error: 400 means a bad request.");
  });
});
