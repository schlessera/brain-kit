// A turn that ended on an API error replays as a failure on its assistant
// message, not as prose (#575). The transcript is read through the real
// `buildSessionHistory`, fed what the SDK's transcript reader returns: the
// entry's `message` only, its `isApiErrorMessage` and `error` fields dropped.
import { describe, expect, test } from "bun:test";
import type { getSessionMessages, SessionMessage } from "@anthropic-ai/claude-agent-sdk";

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
  buildSessionHistory(SESSION, (async () => entries) as unknown as typeof getSessionMessages, "/brain");

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

  test("the runtime's other synthetic messages replay as text", async () => {
    for (const text of ["No response requested.", "API Error: Request was aborted."]) {
      const [, message] = await read([userTurn("hi"), syntheticEntry(text)]);
      expect(message!.failure).toBeUndefined();
      expect(message!.content).toBe(text);
    }
  });

  test("a model's answer that talks about an API error is not a failure", async () => {
    const [, message] = await read([userTurn("What does 400 mean?"), answerEntry("API Error: 400 means a bad request.")]);
    expect(message!.failure).toBeUndefined();
    expect(message!.content).toBe("API Error: 400 means a bad request.");
  });
});
