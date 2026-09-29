import { describe, expect, test } from "bun:test";

import {
  ASK_USER_LIST_CONTRACT,
  ASK_USER_LIST_INPUT_SCHEMA,
  ASK_USER_LIST_LIMITS,
  parseToolPayload,
  toolInputJsonSchema,
  type AskUserListInput,
} from "../src/tool-contracts/index";
import { handleAskUserList } from "../src/server/bridge-tools/index";
import type { AskUserListResult, BackendBridge } from "../src/server/backend";
import type { AskUserListSpec } from "../src/protocol";
import { parseClientMessage, parseServerMessage } from "../src/schemas";

const SCALE = ["loved", "liked", "meh", "hated", "not seen", "not interested"];

/** The issue's own case: ten films on a six-option scale, in one call. */
const TEN_FILMS: AskUserListInput = {
  prompt: "How did these land?",
  scale: SCALE.map((label) => ({ label })),
  items: Array.from({ length: 10 }, (_, i) => ({
    id: `film-${i + 1}`,
    label: `Film ${i + 1}`,
    detail: `${2014 + i}`,
  })),
};

/** A bridge that records what it was asked and answers with `result`. */
function recordingBridge(result: AskUserListResult) {
  const asked: { requestId: string; spec: AskUserListSpec }[] = [];
  const bridge = {
    askUserList: async (requestId: string, spec: AskUserListSpec) => {
      asked.push({ requestId, spec });
      return result;
    },
  } as unknown as BackendBridge;
  return { bridge, asked };
}

describe("ask_user_list: ten items, six options, one call", () => {
  test("the input schema takes the whole list in one call", () => {
    const parsed = ASK_USER_LIST_INPUT_SCHEMA.safeParse(TEN_FILMS);
    expect(parsed.success).toBe(true);
    expect(TEN_FILMS.items).toHaveLength(10);
    expect(TEN_FILMS.scale).toHaveLength(6);
  });

  test("the result lists id → option label for every answer, and the skipped ids", async () => {
    const answers = {
      "film-1": "loved",
      "film-2": "liked",
      "film-4": "not seen",
      "film-7": "hated",
    };
    const { bridge, asked } = recordingBridge({ answers });
    const payload = await handleAskUserList(TEN_FILMS, bridge, "req-1");

    // One request reached the bridge, carrying every item and the defaults.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.requestId).toBe("req-1");
    expect(asked[0]!.spec.items.map((i) => i.id)).toEqual(TEN_FILMS.items.map((i) => i.id));
    expect(asked[0]!.spec.allowSkip).toBe(true);
    expect(asked[0]!.spec.notes).toBe(false);

    expect(payload.answers).toEqual(answers);
    expect(payload.skipped).toEqual(["film-3", "film-5", "film-6", "film-8", "film-9", "film-10"]);
    expect(payload.notes).toBeUndefined();
    // The payload is what the tool returns as JSON, and it parses back.
    expect(parseToolPayload(ASK_USER_LIST_CONTRACT, JSON.stringify(payload))).toEqual(payload as never);
  });

  test("a skipped item is absent from answers, never an empty string", async () => {
    const { bridge } = recordingBridge({ answers: { "film-1": "", "film-2": "meh" } });
    const payload = await handleAskUserList(TEN_FILMS, bridge, "req-2");
    expect(Object.hasOwn(payload.answers, "film-1")).toBe(false);
    expect(payload.skipped).toContain("film-1");
    expect(payload.answers).toEqual({ "film-2": "meh" });
  });

  test("an answer for an unknown id or an unknown option is dropped, not passed on", async () => {
    const { bridge } = recordingBridge({
      answers: { "film-1": "loved", "film-2": "adored", "film-99": "loved" },
    });
    const payload = await handleAskUserList(TEN_FILMS, bridge, "req-3");
    expect(payload.answers).toEqual({ "film-1": "loved" });
    expect(payload.skipped).toHaveLength(9);
    // answers and skipped partition the list.
    expect(Object.keys(payload.answers).length + payload.skipped.length).toBe(10);
  });

  test("notes travel separately, reach the agent for a skipped item, and only when enabled", async () => {
    const result = {
      answers: { "film-1": "loved" },
      notes: { "film-1": "  rewatch  ", "film-2": "never heard of it", "film-3": "   ", nope: "x" },
    };
    const on = await handleAskUserList({ ...TEN_FILMS, notes: true }, recordingBridge(result).bridge, "n1");
    expect(on.notes).toEqual({ "film-1": "rewatch", "film-2": "never heard of it" });
    expect(on.skipped).toContain("film-2");

    const off = await handleAskUserList(TEN_FILMS, recordingBridge(result).bridge, "n2");
    expect(off.notes).toBeUndefined();

    const long = "x".repeat(ASK_USER_LIST_LIMITS.maxNote + 50);
    const capped = await handleAskUserList(
      { ...TEN_FILMS, notes: true },
      recordingBridge({ answers: {}, notes: { "film-1": long } }).bridge,
      "n3"
    );
    expect(capped.notes?.["film-1"]).toHaveLength(ASK_USER_LIST_LIMITS.maxNote);
  });

  test("duplicate ids and duplicate scale labels are refused before any card is drawn", async () => {
    const { bridge, asked } = recordingBridge({ answers: {} });
    await expect(
      handleAskUserList(
        { ...TEN_FILMS, items: [TEN_FILMS.items[0]!, { ...TEN_FILMS.items[1]!, id: "film-1" }] },
        bridge
      )
    ).rejects.toThrow('item id "film-1" is used twice');
    await expect(
      handleAskUserList({ ...TEN_FILMS, scale: [{ label: "a" }, { label: "a" }] }, bridge)
    ).rejects.toThrow('scale option "a" is listed twice');
    expect(asked).toHaveLength(0);
  });

  test("a host without the bridge method says so", async () => {
    await expect(handleAskUserList(TEN_FILMS, {} as BackendBridge)).rejects.toThrow(
      "does not support ask_user_list"
    );
  });

  test("the advertised schema presents the defaults as optional", () => {
    const schema = toolInputJsonSchema(ASK_USER_LIST_CONTRACT) as {
      required: string[];
      properties: Record<string, { maxItems?: number; minItems?: number }>;
    };
    expect(schema.required.sort()).toEqual(["items", "prompt", "scale"]);
    expect(schema.properties.scale).toMatchObject({ minItems: 2, maxItems: 8 });
    expect(schema.properties.items).toMatchObject({ minItems: 1, maxItems: 30 });
  });
});

describe("ask_user_list protocol frames", () => {
  test("the request frame round-trips through the server parser", () => {
    const frame = {
      type: "ask_user_list_request",
      requestId: "r",
      prompt: "How did these land?",
      scale: [{ label: "loved" }, { label: "meh", description: "fine" }],
      items: [{ id: "a", label: "A", detail: "2024", link: "https://example.org" }],
      allowSkip: true,
      notes: false,
      sessionId: "s",
    };
    const parsed = parseServerMessage(JSON.stringify(frame));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message).toMatchObject(frame);
  });

  test("the response frame carries answers and notes keyed by id", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "ask_user_list_response",
        requestId: "r",
        answers: { a: "loved" },
        notes: { b: "later" },
      })
    );
    expect(parsed.ok).toBe(true);
  });

  test("a response with a non-string answer is refused", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: "ask_user_list_response", requestId: "r", answers: { a: 1 } })
    );
    expect(parsed.ok).toBe(false);
  });
});
