// Render tests for the `show_block` result (D41): every variant mounts its
// kit component from a payload the contract accepts, the trace summary reads
// the shape, and a result that fails the schema falls back to its own words
// rather than a blank. Props-only, keyless, mounted in happy-dom. Queries
// come from `render()`, never `screen` — see tests/render/dom.ts for why.
import { unregisterBlockCardDom } from "./block-card-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  SHOW_BLOCK_CONTRACT,
  parseToolPayload,
  resetToolRenderers,
  resolveToolRenderer,
  visibleToolName,
  type Block,
  type ToolCallView,
} from "@schlessera/brain-ui-sdk/client";

import {
  BlockCard,
  blockSummary,
  kitIcon,
} from "../../src/components/chat/tool-cards/block-card.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { isShowBlockTool } from "../../src/lib/tool-names.js";

afterEach(cleanup);
afterAll(() => {
  resetToolRenderers();
  unregisterBlockCardDom();
});

import { BLOCKS, SUGGESTIONS, type AnswerBlockKind } from "../block-fixtures.js";

/** Text each variant must put on the page, from the payload's own words. */
const EXPECTED_TEXT: Record<AnswerBlockKind, string[]> = {
  comparison: ["Ithaca", "Days at sea", "Home costs a longer crossing."],
  stats: ["Ships", "600"],
  trend: ["Ships remaining", "−11", "Thrinacia"],
  table: ["Aeaea", "2555"],
  bars: ["Ogygia", "7 y"],
  receipt: ["Suitors", "counted", "the great hall only"],
  steps: ["Shoot through the axes", "12 axes"],
  timeline: ["Troy falls", "disguised as a beggar"],
  schedule: ["Today", "Open the bag", "conflict"],
  quote: ["Sing to me of the man, Muse.", "Book 1, line 1"],
  contact: ["Eumaeus", "swineherd", "20 years ago"],
};

describe("BlockCard", () => {
  for (const kind of Object.keys(BLOCKS) as AnswerBlockKind[]) {
    test(`${kind}: the contract accepts the payload and the kit draws its words`, () => {
      const payload = parseToolPayload(
        SHOW_BLOCK_CONTRACT,
        JSON.stringify({ block: BLOCKS[kind] })
      );
      expect(payload).not.toBeNull();
      const { container } = render(<BlockCard {...payload!} />);
      expect(container.querySelector(`[data-block="${kind}"]`)).not.toBeNull();
      for (const text of EXPECTED_TEXT[kind]) {
        expect(container.textContent).toContain(text);
      }
    });
  }

  test("a sparse block shows nothing the model did not say — never the kit's demo defaults", () => {
    // The kit ports the design's demo defaults for optional text props; a
    // block that omits them must not inherit the Odysseus fixture world.
    const sparse: Block[] = [
      { kind: "quote", quote: "Only these words." },
      { kind: "contact", label: "Eurycleia" },
      { kind: "trend", values: [1, 2, 3] },
      { kind: "receipt", rows: [{ k: "k", v: "v" }] },
      { kind: "comparison", columns: [{ label: "A" }, { label: "B" }], rows: [{ label: "r", cells: ["1", "2"] }] },
    ];
    for (const block of sparse) {
      const { container } = render(<BlockCard block={block} />);
      const shown = container.textContent ?? "";
      expect(shown).not.toContain("teiresias");
      expect(shown).not.toContain("line 12");
      expect(shown).not.toContain("Penelope");
      expect(shown).not.toContain("Ithaca");
      expect(shown).not.toContain("Spend");
      expect(shown).not.toContain("$8.50");
      expect(shown).not.toContain("Capability");
      expect(shown).not.toContain("standing grant");
      expect(shown).not.toContain("Six men");
      expect(shown).not.toContain("open threads");
      expect(shown).not.toContain("Thu");
      cleanup();
    }
  });

  test("an icon key the kit does not know is dropped, a known one passes", () => {
    expect(kitIcon("wallet")).toBe("wallet");
    expect(kitIcon("not-a-kit-icon")).toBeUndefined();
    expect(kitIcon(undefined)).toBeUndefined();
    // Inherited keys are not icons: `"constructor" in ICONS` is true.
    expect(kitIcon("constructor")).toBeUndefined();
    expect(kitIcon("__proto__")).toBeUndefined();
    // The stats payload above carries one of each; both tiles render.
    const { container } = render(<BlockCard block={BLOCKS.stats} />);
    expect(container.textContent).toContain("Days");
  });

  test("the trace summary reads the shape, not the contents", () => {
    expect(blockSummary({ block: BLOCKS.comparison })).toBe("comparison · 3 columns · 2 rows");
    expect(blockSummary({ block: BLOCKS.stats })).toBe("stats · 3 tiles");
    expect(blockSummary({ block: BLOCKS.trend })).toBe("trend · Ships remaining");
    expect(blockSummary({ block: BLOCKS.table })).toBe("table · 2 columns · 2 rows");
    expect(blockSummary({ block: BLOCKS.receipt })).toBe("receipt · Suitors");
    expect(blockSummary({ block: BLOCKS.steps })).toBe("steps · 3 steps");
    expect(blockSummary({ block: BLOCKS.timeline })).toBe("timeline · 2 events");
    expect(blockSummary({ block: BLOCKS.schedule })).toBe("schedule · 1 day");
    expect(blockSummary({ block: BLOCKS.quote })).toBe("quote · Odyssey");
    expect(blockSummary({ block: BLOCKS.contact })).toBe("contact · Eumaeus");
    expect(blockSummary({ block: SUGGESTIONS })).toBe("suggestions · 2");
  });

  test("suggestions draw nothing where they are called: the closing row takes them (D50)", () => {
    const { container } = render(<BlockCard block={SUGGESTIONS} />);
    expect(container.querySelector('[data-block="suggestions"]')?.textContent).toBe("");
  });
});

describe("the bound renderer", () => {
  const claudeName = visibleToolName(SHOW_BLOCK_CONTRACT.name, "claude");
  const piName = visibleToolName(SHOW_BLOCK_CONTRACT.name, "pi");

  function call(name: string, output: string | undefined, isError = false): ToolCallView {
    return { id: "b1", name, input: {}, ...(output === undefined ? {} : { output }), isError };
  }

  test("resolves under every spelling of the name, on any backend", () => {
    registerBuiltinRenderers();
    for (const [name, backend] of [
      [claudeName, "claude"],
      [piName, "pi"],
      ["mcp__brain_ui__show_block", "claude"],
    ] as const) {
      const renderer = resolveToolRenderer(call(name, undefined), backend);
      expect(renderer?.label).toBe("Block");
      expect(isShowBlockTool(name)).toBe(true);
    }
    expect(isShowBlockTool("Bash")).toBe(false);
  });

  test("a rejected call falls back to the result's own words, never a blank", () => {
    registerBuiltinRenderers();
    const renderer = resolveToolRenderer(call(piName, undefined), "pi")!;
    const Output = renderer.Output!;
    const rejected = call(piName, "block.columns: Too small: expected array to have >=2 items", true);
    const { container } = render(<Output tool={rejected} />);
    expect(container.textContent).toContain("Too small");
    expect(renderer.summary?.(rejected)).toBeNull();

    const drawn = call(piName, JSON.stringify({ block: BLOCKS.quote }));
    const { container: card } = render(<Output tool={drawn} />);
    expect(card.querySelector('[data-block="quote"]')).not.toBeNull();
    expect(renderer.summary?.(drawn)).toBe("quote · Odyssey");
  });
});
