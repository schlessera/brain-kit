import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  ASK_USER_CONTRACT,
  ASK_USER_LIST_CONTRACT,
  ASK_USER_RANK_CONTRACT,
  ASK_USER_FORM_CONTRACT,
  BRIDGE_TOOL_CONTRACTS,
  BRIDGE_TOOL_POSTURE,
  GET_CURRENT_LOCATION_CONTRACT,
  QUERY_ACTIVITY_CONTRACT,
  REQUEST_IMAGE_MASK_CONTRACT,
  SHOW_BLOCK_CONTRACT,
  BLOCK_KINDS,
  bridgeContractForToolName,
  parseToolPayload,
  toolBriefLines,
  toolInputJsonSchema,
  visibleToolName,
} from "../src/tool-contracts/index";
import { buildSystemPromptAppend } from "../src/server/system-prompt";

describe("the contract list is the single source", () => {
  test("the auto-allow posture names exactly the contracts, in order", () => {
    expect(BRIDGE_TOOL_POSTURE.names).toEqual(
      BRIDGE_TOOL_CONTRACTS.map((contract) => contract.name) as never
    );
  });

  test("every contract carries a brief, and it names the tool it describes", () => {
    for (const contract of BRIDGE_TOOL_CONTRACTS) {
      const claudeName = visibleToolName(contract.name, "claude");
      expect(contract.brief(claudeName)).toContain(`\`${claudeName}\``);
      expect(contract.brief(contract.name)).toContain(`\`${contract.name}\``);
    }
  });

  test("a contract reaches the prompt when the backend declares its tool", () => {
    // The whole point of generating the section: a tool that is schema'd but
    // never described to the model cannot happen, because the prompt is built
    // by walking this same list.
    const prompt = buildSystemPromptAppend({
      tools: {
        askUser: visibleToolName(ASK_USER_CONTRACT.name, "claude"),
        askUserList: ASK_USER_LIST_CONTRACT.name,
        askUserRank: ASK_USER_RANK_CONTRACT.name,
        askUserForm: ASK_USER_FORM_CONTRACT.name,
        location: GET_CURRENT_LOCATION_CONTRACT.name,
        mask: REQUEST_IMAGE_MASK_CONTRACT.name,
        activity: QUERY_ACTIVITY_CONTRACT.name,
        block: SHOW_BLOCK_CONTRACT.name,
      },
    });
    for (const contract of BRIDGE_TOOL_CONTRACTS) {
      const declared =
        contract === ASK_USER_CONTRACT
          ? visibleToolName(contract.name, "claude")
          : contract.name;
      expect(prompt).toContain(contract.brief(declared));
    }
  });

  test("a tool the backend does not expose is not described", () => {
    const prompt = buildSystemPromptAppend({
      tools: { askUser: ASK_USER_CONTRACT.name, location: false },
    });
    expect(prompt).toContain(ASK_USER_CONTRACT.brief(ASK_USER_CONTRACT.name));
    expect(prompt).not.toContain("ask_user_list");
    expect(prompt).not.toContain("get_current_location");
    expect(prompt).not.toContain("request_image_mask");
    expect(prompt).not.toContain("show_block");
  });

  test("toolBriefLines keeps contract order and skips the undeclared", () => {
    const lines = toolBriefLines(BRIDGE_TOOL_CONTRACTS, (contract) =>
      contract === QUERY_ACTIVITY_CONTRACT ? false : contract.name
    );
    expect(lines).toEqual([
      ASK_USER_CONTRACT.brief(ASK_USER_CONTRACT.name),
      ASK_USER_LIST_CONTRACT.brief(ASK_USER_LIST_CONTRACT.name),
      ASK_USER_RANK_CONTRACT.brief(ASK_USER_RANK_CONTRACT.name),
      ASK_USER_FORM_CONTRACT.brief(ASK_USER_FORM_CONTRACT.name),
      GET_CURRENT_LOCATION_CONTRACT.brief(GET_CURRENT_LOCATION_CONTRACT.name),
      REQUEST_IMAGE_MASK_CONTRACT.brief(REQUEST_IMAGE_MASK_CONTRACT.name),
      SHOW_BLOCK_CONTRACT.brief(SHOW_BLOCK_CONTRACT.name),
    ]);
  });
});

describe("show_block", () => {
  test("the brief rides every turn, so it stays at eleven lines and names every kind", () => {
    // D43 measured these eleven lines at 257 input tokens on every turn,
    // against a `show_block` rate of 59% with them and 2% without — near zero
    // rather than merely lower, because the tools were deferred behind tool
    // search and the brief was the only text naming them. D44 always-loads
    // them, and in that configuration the brief measures at no effect at all
    // (77%/77% and 76%/77%, two runs). The budgets stay pinned at what was
    // measured until #157 re-decides what the brief is for; they are a ceiling
    // on drift, not evidence that the lines earn their place. Measured on the
    // name the Claude backend actually sends: the MCP prefix is fifteen of
    // those characters.
    const brief = SHOW_BLOCK_CONTRACT.brief(
      visibleToolName(SHOW_BLOCK_CONTRACT.name, "claude")
    );
    // The naming check goes FIRST on purpose. It was below the budgets, and a
    // change that both dropped a kind and lengthened the brief tripped the
    // character budget first — so "the brief stopped naming `contact`" got
    // reported as "the brief is too long". The test failed either way, but it
    // named the wrong cause. Cheapest fix is the ordering: the semantic
    // assertion reports before the two that measure size.
    //
    // `suggestions` is the one kind the brief does not name, by ruling (#40,
    // D50): the brief sits at this ceiling, and under D44 it measured no
    // effect on the call rate, so its rule rides in the always-loaded
    // description instead. #550 measures whether that holds. Any OTHER kind
    // the brief stops naming still fails here.
    const BRIEF_EXEMPT: readonly string[] = ["suggestions"];
    for (const kind of BLOCK_KINDS) {
      if (BRIEF_EXEMPT.includes(kind)) expect(brief).not.toContain(`\`${kind}\``);
      else expect(brief).toContain(`\`${kind}\``);
    }
    expect(brief.split("\n").length).toBeLessThanOrEqual(11);
    // Lines alone do not bound it — eleven long ones cost more than twelve
    // short ones, and tokens are what ride the turn. 749 characters is what
    // was measured at 257 tokens.
    expect(brief.length).toBeLessThanOrEqual(749);
  });

  test("the description carries the shape rules once, and names every kind", () => {
    const description = SHOW_BLOCK_CONTRACT.description;
    for (const kind of BLOCK_KINDS) expect(description).toContain(`${kind}:`);
    expect(description).toContain("at most one column recommended");
    expect(description).toContain("no arithmetic");
    // The Receipt value budget, measured by ui-kit's browser suite
    // (`tests/visual/receipt-value-budget.visual.tsx`), so a value the model
    // judges is written to fit.
    expect(description).toContain("a toned value fits one phone line at 25 characters");
  });

  test("suggestions: one or two one-line follow-ups, never a third, never a tone", () => {
    const parse = (block: unknown) =>
      parseToolPayload(SHOW_BLOCK_CONTRACT, JSON.stringify({ block }));
    const one = { label: "Who was on watch then?" };
    expect(parse({ kind: "suggestions", items: [one] })).toEqual({
      block: { kind: "suggestions", items: [one] },
    });
    expect(
      parse({ kind: "suggestions", label: "Ask next", items: [one, { label: "What did Circe say?", icon: "ask" }] })
    ).not.toBeNull();
    // Trimmed before the bounds apply, so padding cannot smuggle a short one in.
    expect(parse({ kind: "suggestions", items: [{ label: "  Hi?  " }] })).toBeNull();
    expect(parse({ kind: "suggestions", items: [{ label: "  Why not?  " }] })).toEqual({
      block: { kind: "suggestions", items: [{ label: "Why not?" }] },
    });
    expect(parse({ kind: "suggestions", items: [] })).toBeNull();
    expect(parse({ kind: "suggestions", items: [one, one, one] })).toBeNull();
    expect(parse({ kind: "suggestions", items: [{ label: "x".repeat(81) }] })).toBeNull();
    expect(parse({ kind: "suggestions", items: [{ label: "x".repeat(80) }] })).not.toBeNull();
    expect(parse({ kind: "suggestions", items: [{ label: "line one\nline two" }] })).toBeNull();
    expect(parse({ kind: "suggestions", label: "", items: [one] })).toBeNull();
    // A tone is not part of the shape: the strict tree strips it, so no chip
    // is ever drawn amber.
    expect(parse({ kind: "suggestions", items: [{ ...one, tone: "amber" }] })).toEqual({
      block: { kind: "suggestions", items: [one] },
    });
  });

  test("the fifteen kinds, in brief order", () => {
    expect(BLOCK_KINDS).toEqual([
      "comparison",
      "stats",
      "trend",
      "table",
      "bars",
      "receipt",
      "steps",
      "timeline",
      "schedule",
      "quote",
      "contact",
      "map",
      "track",
      "link",
      "suggestions",
    ]);
  });

  test("the payload is the input: a valid block round-trips, a wrong one is null", () => {
    const block = {
      kind: "comparison" as const,
      columns: [{ label: "Ithaca", recommended: true }, { label: "Pylos" }],
      rows: [{ label: "Days at sea", cells: ["0", { v: "4", tone: "red" as const }] }],
      footnote: "Home costs nothing to reach.",
    };
    expect(
      parseToolPayload(SHOW_BLOCK_CONTRACT, JSON.stringify({ block }))
    ).toEqual({ block });
    expect(
      parseToolPayload(
        SHOW_BLOCK_CONTRACT,
        JSON.stringify({ block: { kind: "comparison", columns: [], rows: [] } })
      )
    ).toBeNull();
    expect(
      parseToolPayload(
        SHOW_BLOCK_CONTRACT,
        JSON.stringify({ block: { kind: "trend", values: [1, 2], tone: "pink" } })
      )
    ).toBeNull();
    expect(
      parseToolPayload(SHOW_BLOCK_CONTRACT, JSON.stringify({ block: { kind: "chart" } }))
    ).toBeNull();
  });
});

describe("names the model sees", () => {
  test("claude sees the MCP-prefixed name, pi the bare one", () => {
    expect(visibleToolName("ask_user", "claude")).toBe("mcp__brain-ui__ask_user");
    expect(visibleToolName("ask_user", "pi")).toBe("ask_user");
  });

  test("a contract resolves from either adapter's name", () => {
    expect(bridgeContractForToolName("ask_user")).toBe(ASK_USER_CONTRACT);
    expect(bridgeContractForToolName("mcp__brain-ui__ask_user")).toBe(
      ASK_USER_CONTRACT
    );
    expect(bridgeContractForToolName("Bash")).toBeUndefined();
  });
});

describe("input JSON Schema", () => {
  test("it is the bare object every backend wants — no $schema key", () => {
    for (const contract of BRIDGE_TOOL_CONTRACTS) {
      const schema = toolInputJsonSchema(contract);
      expect(schema).not.toHaveProperty("$schema");
      const { $schema: _drop, ...expected } = z.toJSONSchema(contract.input, {
        io: "input",
      });
      expect(schema).toEqual(expected);
    }
  });

  test("a bare input schema converts identically to its contract", () => {
    expect(toolInputJsonSchema(ASK_USER_CONTRACT.input)).toEqual(
      toolInputJsonSchema(ASK_USER_CONTRACT)
    );
  });
});

describe("parseToolPayload degrades instead of throwing", () => {
  const fix = {
    latitude: 38.36,
    longitude: 20.71,
    accuracyMeters: 25,
    retrievedAt: "2026-07-12T09:00:00.000Z",
  };

  test("valid JSON parses to the payload", () => {
    expect(
      parseToolPayload(GET_CURRENT_LOCATION_CONTRACT, JSON.stringify(fix))
    ).toEqual(fix);
  });

  test("unknown keys survive, because a newer server may add them", () => {
    const parsed = parseToolPayload(
      GET_CURRENT_LOCATION_CONTRACT,
      JSON.stringify({ ...fix, altitudeMeters: 12 })
    );
    expect(parsed).toMatchObject({ ...fix, altitudeMeters: 12 });
  });

  test("prose, an absent output, an empty string and a wrong shape give null", () => {
    expect(
      parseToolPayload(GET_CURRENT_LOCATION_CONTRACT, "Mask written to x.png.")
    ).toBeNull();
    expect(parseToolPayload(GET_CURRENT_LOCATION_CONTRACT, undefined)).toBeNull();
    expect(parseToolPayload(GET_CURRENT_LOCATION_CONTRACT, "   ")).toBeNull();
    expect(
      parseToolPayload(
        GET_CURRENT_LOCATION_CONTRACT,
        JSON.stringify({ ...fix, latitude: "38.36" })
      )
    ).toBeNull();
    // A payload that is valid for a DIFFERENT contract is still null here.
    expect(
      parseToolPayload(
        GET_CURRENT_LOCATION_CONTRACT,
        JSON.stringify({
          maskPath: "a-mask.png",
          imagePath: "a.png",
          bytes: 3,
          note: "x",
        })
      )
    ).toBeNull();
  });

  test("an errored call's message is prose, so it parses to null", () => {
    expect(
      parseToolPayload(
        REQUEST_IMAGE_MASK_CONTRACT,
        "The host does not support request_image_mask in this session."
      )
    ).toBeNull();
  });

  test("ask_user's payload round-trips with its annotations", () => {
    const payload = {
      questions: [
        {
          question: "Which port?",
          header: "Port",
          multiSelect: false,
          options: [
            { label: "Ithaca", description: "Home" },
            { label: "Pylos", description: "Nestor's", preview: "```\n```" },
          ],
        },
      ],
      answers: { Port: "Ithaca" },
      annotations: { Port: { notes: "asked twice" } },
    };
    expect(
      parseToolPayload(ASK_USER_CONTRACT, JSON.stringify(payload))
    ).toEqual(payload);
  });
});
