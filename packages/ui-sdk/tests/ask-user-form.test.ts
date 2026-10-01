import { handleAskUserForm } from "../src/server/bridge-tools/ask-user-form.js";
import type { BackendBridge } from "../src/server/backend.js";
import { parseClientMessage, parseServerMessage } from "../src/schemas.js";
import { describe, expect, test } from "bun:test";
import {
  askUserFormSpec,
  askUserFormPayload,
  askUserFormVisibleNodes,
  resolveAskUserFormLimits,
  ASK_USER_FORM_INPUT_SCHEMA,
  type AskUserFormInput,
} from "../src/tool-contracts/form.js";
const form: AskUserFormInput = {
  prompt: "Plan the evening",
  nodes: [
    {
      id: "activity",
      kind: "single",
      prompt: "What kind of evening?",
      options: [{ label: "Film" }, { label: "Game" }, { label: "Walk" }],
    },
    {
      id: "genres",
      kind: "multi",
      prompt: "Which genres?",
      showIf: { node: "activity", anyOf: ["Film"] },
      options: [{ label: "Adventure" }, { label: "Comedy" }],
    },
    {
      id: "games",
      kind: "rank",
      prompt: "Rank the games",
      showIf: { node: "activity", anyOf: ["Game"] },
      items: [
        { id: "voyage", label: "Voyage" },
        { id: "harbor", label: "Harbor" },
      ],
    },
    {
      id: "distance",
      kind: "single",
      prompt: "How far?",
      showIf: { node: "activity", anyOf: ["Walk"] },
      options: [{ label: "Short" }, { label: "Long" }],
    },
  ],
};
describe("conditional form", () => {
  test("film/game/walk uses one schema and drops held hidden answers", () => {
    const spec = askUserFormSpec(ASK_USER_FORM_INPUT_SCHEMA.parse(form));
    const answers = {
      activity: { value: "Game" },
      genres: { values: ["Adventure"] },
      distance: { value: "Short" },
      games: { order: ["harbor", "voyage"], unchanged: true },
    };
    expect(answers.genres.values.length).toBeGreaterThan(0);
    expect(askUserFormPayload(spec, { answers })).toEqual({
      answers: {
        activity: { value: "Game" },
        games: { order: ["harbor", "voyage"], unchanged: false },
      },
      visibleNodes: ["activity", "games"],
    });
  });
  test("Other text matching a label cannot open a branch", () => {
    expect(
      askUserFormVisibleNodes(form, {
        activity: { value: "Film", other: true },
      }),
    ).toEqual(["activity"]);
  });
  test("conditions require an earlier offered label on a choice parent", () => {
    for (const node of ["missing", "distance"])
      expect(() =>
        askUserFormSpec({
          ...form,
          nodes: [
            form.nodes[0]!,
            { ...form.nodes[1]!, showIf: { node, anyOf: ["Film"] } },
          ],
        }),
      ).toThrow("earlier");
    expect(() =>
      askUserFormSpec({
        ...form,
        nodes: [
          form.nodes[0]!,
          { ...form.nodes[1]!, showIf: { node: "activity", anyOf: ["Other"] } },
        ],
      }),
    ).toThrow("offered");
    expect(() =>
      askUserFormSpec({
        prompt: "Question",
        nodes: [
          { id: "a", kind: "text", prompt: "A?" },
          {
            id: "b",
            kind: "text",
            prompt: "B?",
            showIf: { node: "a", anyOf: ["yes"] },
          },
        ],
      }),
    ).toThrow("single/multi");
  });
  test("depth/node/options defaults and independent overrides are enforced", () => {
    const chain: AskUserFormInput = {
      prompt: "A path",
      nodes: Array.from({ length: 4 }, (_, i) => ({
        id: `n${i}`,
        kind: "single",
        prompt: "Continue?",
        options: [{ label: "Yes" }, { label: "No" }],
        ...(i ? { showIf: { node: `n${i - 1}`, anyOf: ["Yes"] } } : {}),
      })),
    };
    expect(() => askUserFormSpec(chain)).toThrow("maxDepth");
    expect(askUserFormSpec(chain, { maxDepth: 4 }).nodes.length).toBe(4);
    expect(() => askUserFormSpec(form, { maxNodes: 3 })).toThrow("maxNodes");
    expect(() => askUserFormSpec(form, { maxOptions: 2 })).toThrow(
      "maxOptions",
    );
    expect(
      askUserFormSpec(form, { maxNodes: 4, maxOptions: 3 }).nodes.length,
    ).toBe(4);
    const many: AskUserFormInput = {
      prompt: "Questions",
      nodes: Array.from({ length: 13 }, (_, i) => ({
        id: `n${i}`,
        kind: "text",
        prompt: "Any notes?",
        required: false,
      })),
    };
    expect(() => askUserFormSpec(many)).toThrow("maxNodes");
    expect(askUserFormSpec(many, { maxNodes: 13 }).nodes.length).toBe(13);
    const options: AskUserFormInput = {
      prompt: "Choose",
      nodes: [
        {
          id: "a",
          kind: "single",
          prompt: "Which?",
          options: Array.from({ length: 9 }, (_, i) => ({ label: String(i) })),
        },
      ],
    };
    expect(() => askUserFormSpec(options)).toThrow("maxOptions");
    expect(askUserFormSpec(options, { maxOptions: 9 }).nodes.length).toBe(1);
  });
  test("invalid config is rejected, never silently defaulted", () => {
    for (const value of [0, -1, 1.5, Infinity, NaN])
      expect(() => resolveAskUserFormLimits({ maxDepth: value })).toThrow();
    expect(() => resolveAskUserFormLimits({ maxOptions: 1 })).toThrow();
  });
  test("missing required visible answers fail, hidden required nodes do not", () => {
    expect(() =>
      askUserFormPayload(form, { answers: { activity: { value: "Film" } } }),
    ).toThrow("genres");
    expect(
      askUserFormPayload(form, {
        answers: { activity: { value: "Walk" }, distance: { value: "Short" } },
      }).visibleNodes,
    ).toEqual(["activity", "distance"]);
  });
  test("duplicate node ids, labels, item ids and invalid cutoff fail before display", () => {
    expect(() =>
      askUserFormSpec({ ...form, nodes: [form.nodes[0]!, form.nodes[0]!] }),
    ).toThrow("unique");
    expect(() =>
      askUserFormSpec({
        prompt: "Choose",
        nodes: [
          {
            id: "a",
            kind: "single",
            prompt: "Which?",
            options: [{ label: "Same" }, { label: "Same" }],
          },
        ],
      }),
    ).toThrow("unique");
    expect(() =>
      askUserFormSpec({
        prompt: "Rank",
        nodes: [
          {
            id: "a",
            kind: "rank",
            prompt: "Which first?",
            items: [
              { id: "same", label: "A" },
              { id: "same", label: "B" },
            ],
          },
        ],
      }),
    ).toThrow("unique");
    expect(() =>
      askUserFormSpec({
        prompt: "Rank",
        nodes: [
          {
            id: "a",
            kind: "rank",
            prompt: "Which first?",
            cutoff: 3,
            items: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      }),
    ).toThrow("cutoff");
  });
});

describe("form boundary and host wiring", () => {
  test("the handler forwards configured overrides, validates before the host, and returns canonical visible answers", async () => {
    const input: AskUserFormInput = {
      prompt: "Choose",
      nodes: [
        {
          id: "a",
          kind: "single",
          prompt: "Which?",
          options: Array.from({ length: 9 }, (_, i) => ({ label: String(i) })),
        },
      ],
    };
    const calls: AskUserFormInput[] = [];
    const bridge: BackendBridge = {
      emit() {},
      async requestPermission() {
        return { behavior: "deny", message: "unused" };
      },
      askUserFormLimits: { maxDepth: 4, maxNodes: 20, maxOptions: 9 },
      async askUserForm(_, request) {
        calls.push(request);
        return { answers: { a: { value: "8" } } };
      },
    };
    expect(await handleAskUserForm(input, bridge, "request")).toEqual({
      answers: { a: { value: "8" } },
      visibleNodes: ["a"],
    });
    expect(calls[0]?.nodes.length).toBe(1);
    bridge.askUserFormLimits = { maxDepth: 3, maxNodes: 12, maxOptions: 8 };
    await expect(handleAskUserForm(input, bridge)).rejects.toThrow(
      "maxOptions",
    );
    expect(calls.length).toBe(1);
  });
  test("wire schemas preserve nested additive fields and reject malformed typed values", () => {
    const request = {
      type: "ask_user_form_request" as const,
      requestId: "r",
      ...form,
      sessionId: "s",
      turnId: "t",
      future: true,
      nodes: form.nodes.map((node) => ({ ...node, future: "node" })),
    };
    expect(parseServerMessage(JSON.stringify(request))).toEqual({
      ok: true,
      message: request,
    });
    const response = {
      type: "ask_user_form_response" as const,
      requestId: "r",
      turnId: "t",
      answers: { activity: { value: "Game", future: true } },
    };
    expect(parseClientMessage(JSON.stringify(response))).toEqual({
      ok: true,
      message: response,
    });
    expect(
      parseClientMessage(
        JSON.stringify({ ...response, answers: { activity: 3 } }),
      ).ok,
    ).toBe(false);
  });
  test("multi conditions match any selected offered label, and a hidden ancestor hides every descendant", () => {
    const input: AskUserFormInput = {
      prompt: "Choose",
      nodes: [
        form.nodes[0]!,
        form.nodes[1]!,
        {
          id: "text",
          kind: "text",
          prompt: "Why?",
          showIf: { node: "genres", anyOf: ["Comedy"] },
        },
      ],
    };
    expect(
      askUserFormVisibleNodes(input, {
        activity: { value: "Film" },
        genres: { values: ["Adventure", "Comedy"] },
      }),
    ).toEqual(["activity", "genres", "text"]);
    expect(
      askUserFormVisibleNodes(input, {
        activity: { value: "Game" },
        genres: { values: ["Comedy"] },
      }),
    ).toEqual(["activity"]);
  });
  test("scale filters invented ids and notes, derives skipped, and optional text may be absent", () => {
    const input: AskUserFormInput = {
      prompt: "Rate",
      nodes: [
        {
          id: "scale",
          kind: "scale",
          prompt: "Rate?",
          required: false,
          notes: true,
          scale: [{ label: "Keep" }, { label: "Pass" }],
          items: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
        { id: "note", kind: "text", prompt: "Why?", required: false },
      ],
    };
    const raw = {
      answers: {
        scale: {
          answers: { a: "Keep", b: "Invented", fake: "Keep" },
          skipped: [],
          notes: { a: "  reason  ", fake: "Drop" },
        },
        note: "  ",
      },
    };
    expect(Object.keys(raw.answers.scale.answers).length).toBeGreaterThan(0);
    expect(askUserFormPayload(input, raw)).toEqual({
      answers: {
        scale: {
          answers: { a: "Keep" },
          skipped: ["b"],
          notes: { a: "reason" },
        },
      },
      visibleNodes: ["scale", "note"],
    });
  });
});
