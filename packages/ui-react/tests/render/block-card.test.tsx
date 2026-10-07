// Render tests for the `show_block` result (D41): every variant mounts its
// kit component from a payload the contract accepts, the trace summary reads
// the shape, and a result that fails the schema falls back to its own words
// rather than a blank. Props-only, keyless, mounted in happy-dom. Queries
// come from `render()`, never `screen` — see tests/render/dom.ts for why.
import { unregisterBlockCardDom } from "./block-card-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render as mount, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import {
  SHOW_BLOCK_CONTRACT,
  parseToolPayload,
  planPlaces,
  visibleToolName,
  type Block,
  type ToolCallView,
} from "@schlessera/brain-ui-sdk/client";
import { resetToolRenderers, resolveToolRenderer } from "../../../ui-sdk/src/client/renderers.js";

import {
  BlockCard,
  blockSummary,
  kitIcon,
} from "../../src/components/chat/tool-cards/block-card.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import type { CoastlineGeometry } from "../../src/lib/api-client.js";
import { isShowBlockTool } from "../../src/lib/tool-names.js";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";

afterEach(cleanup);
afterAll(() => {
  resetToolRenderers();
  unregisterBlockCardDom();
});

import { BLOCKS, SUGGESTIONS, type AnswerBlockKind } from "../block-fixtures.js";

/**
 * Every request the rendered blocks make, answered here and nowhere else.
 * The `map` block asks the server's `/geo/coastline` for its frames; this is
 * that server, so no render in this file can reach the network.
 */
const requested: string[] = [];
let answer: (url: string) => Promise<Response> = async () =>
  new Response(JSON.stringify(emptyGeometry()), { headers: { "content-type": "application/json" } });

function emptyGeometry(): CoastlineGeometry {
  return {
    coastline: [],
    roads: [],
    streets: [],
    land: [],
    detail: "streets",
    partial: false,
    toleranceM: 5,
    attribution: "© OpenStreetMap contributors",
  };
}

function render(ui: ReactElement) {
  const root = createBrainUiRoot({
    storage: null,
    request: (url) => {
      requested.push(url);
      return answer(url);
    },
  });
  return mount(<BrainUiProvider root={root}>{ui}</BrainUiProvider>);
}

afterEach(() => {
  requested.length = 0;
  answer = async () =>
    new Response(JSON.stringify(emptyGeometry()), { headers: { "content-type": "application/json" } });
});

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
  track: ["Reading original track", "ithaca-loop.gpx"],
  map: ["Where the crew went ashore", "Harbour steps", "Agora well", "Raft timber stand", "no position"],
  link: ["ithaca-harbour.", "example", "Harbour tide tables, week 39", "Title and summary by the brain"],
  tracker: ["github.", "ithaca/", "hall", "opened", "#12", "PR 21", "closed not planned", "Weave a second shroud", "Changes as reported by the brain"],
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
      expect(container.querySelector(`[data-block="${block.kind}"]`)).not.toBeNull();
      const shown = container.textContent ?? "";
      if (block.kind === "trend") {
        const bars = [...container.querySelectorAll<HTMLElement>("span")].filter((node) => node.style.width === "100%");
        expect(bars.map((node) => node.style.height)).toEqual(["21px", "41px", "62px"]);
      }
      else if (block.kind === "quote") expect(shown).toContain("Only these words.");
      else if (block.kind === "contact") expect(shown).toContain("Eurycleia");
      else if (block.kind === "receipt") expect(shown).toContain("k");
      else if (block.kind === "comparison") expect(shown).toContain("r");
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
    expect(blockSummary({ block: BLOCKS.map })).toBe("map · Where the crew went ashore");
    expect(blockSummary({ block: { kind: "map", places: [{ label: "Vathy" }] } })).toBe("map · 1 place");
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

describe("the map block", () => {
  const VATHY = { label: "Vathy", lat: 38.3647, lon: 20.7202 };
  const TROY = { label: "Hisarlik", lat: 39.9575, lon: 26.2389 };
  const street: [number, number][] = [
    [20.719, 38.364],
    [20.721, 38.365],
  ];

  function geometry(over: Partial<CoastlineGeometry>) {
    return async () =>
      new Response(JSON.stringify({ ...emptyGeometry(), ...over }), { headers: { "content-type": "application/json" } });
  }

  test("places saved nowhere are drawn over the existing geometry route, one request per frame", async () => {
    answer = geometry({ streets: [street] });
    const places = [VATHY, { label: "Agora well", lat: 38.3667, lon: 20.7207 }];
    const { container } = render(<BlockCard block={{ kind: "map", places }} />);
    await waitFor(() => expect(container.textContent).toContain("© OpenStreetMap contributors"));
    expect(requested).toHaveLength(1);
    const url = new URL(requested[0]!, "http://brain.test");
    expect(url.pathname).toBe("/api/geo/coastline");
    const [frame] = planPlaces(places).frames;
    expect(url.searchParams.get("bbox")).toBe(frame!.bbox.map((n) => n.toFixed(5)).join(","));
    expect(url.searchParams.get("width")).toBe("495");
    // The street arrived and is drawn, under the brain's own statement about
    // whose positions these are.
    expect(container.querySelectorAll("polyline").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Positions as given by the brain · the map does not check them");
  });

  test("a pair is two requests and one credit", async () => {
    answer = geometry({ coastline: [street] });
    const { container } = render(<BlockCard block={{ kind: "map", places: [VATHY, TROY] }} />);
    await waitFor(() => expect(container.textContent).toContain("© OpenStreetMap contributors"));
    expect(requested).toHaveLength(2);
    expect(container.textContent!.split("© OpenStreetMap contributors")).toHaveLength(2);
    expect(container.textContent).toContain("Too far apart for one map · 508 km between them");
  });

  test("an empty answer is a line and the whole list, never an empty frame", async () => {
    const { container } = render(<BlockCard block={BLOCKS.map} />);
    await waitFor(() => expect(container.textContent).toContain("No map for this area · places listed below"));
    expect(requested).toHaveLength(1);
    expect(container.querySelector('svg[preserveAspectRatio="none"]')).toBeNull();
    expect(container.textContent).not.toContain("OpenStreetMap");
    expect(container.querySelectorAll("li[data-place]")).toHaveLength(3);
  });

  test("a failed request is the same honest line: no server, an old one, an outage", async () => {
    answer = async () => new Response("nope", { status: 500 });
    const { container } = render(<BlockCard block={BLOCKS.map} />);
    await waitFor(() => expect(container.textContent).toContain("No map for this area · places listed below"));
    answer = async () => {
      throw new TypeError("network down");
    };
    cleanup();
    const again = render(<BlockCard block={BLOCKS.map} />);
    await waitFor(() => expect(again.container.textContent).toContain("No map for this area · places listed below"));
    expect(again.container.querySelectorAll("li[data-place]")).toHaveLength(3);
  });

  test("a set too spread out asks for nothing and says why", async () => {
    const { container } = render(
      <BlockCard block={{ kind: "map", places: [{ label: "Ogygia", lat: 36.05, lon: 14.25 }, VATHY, TROY] }} />,
    );
    expect(container.textContent).toContain("Too spread out to draw · 1,140 km across");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requested).toHaveLength(0);
  });

  test("a static render asks for nothing and opens the whole list", async () => {
    const places = Array.from({ length: 12 }, (_, i) => ({ label: `Place ${i + 1}`, lat: 38.36 + i * 0.0003, lon: 20.72 }));
    const { container } = render(<BlockCard block={{ kind: "map", places }} isStatic />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requested).toHaveLength(0);
    expect(container.querySelectorAll("li[data-place]")).toHaveLength(12);
    expect(container.textContent).toContain("No map for this area · places listed below");
  });

  test("a missing coordinate is a row without a pin, never an invented one", async () => {
    answer = geometry({ streets: [street] });
    const { container } = render(<BlockCard block={BLOCKS.map} />);
    await waitFor(() => expect(container.textContent).toContain("© OpenStreetMap contributors"));
    // Three rows, two pins: the third place is listed and not drawn.
    expect(container.querySelectorAll("li[data-place]")).toHaveLength(3);
    const viewport = container.querySelector('[role="img"]')!;
    expect(viewport.getAttribute("aria-label")).toContain("with places 1 and 2");
    expect(container.querySelector('li[data-place="3"]')!.textContent).toContain("no position");
  });

  test("an invalid map payload is refused by the contract, so the generic view draws its words", () => {
    registerBuiltinRenderers();
    const piName = visibleToolName(SHOW_BLOCK_CONTRACT.name, "pi");
    const renderer = resolveToolRenderer({ id: "m", name: piName, input: {}, isError: false }, "pi")!;
    const Output = renderer.Output!;
    const invalid = [
      { kind: "map", places: [{ label: "half", lat: 38.36 }] },
      { kind: "map", places: [] },
      { kind: "map", places: Array.from({ length: 31 }, (_, i) => ({ label: `p${i}` })) },
      { kind: "map", places: [{ label: "x", lat: 95, lon: 20 }] },
    ];
    for (const block of invalid) {
      const output = JSON.stringify({ block });
      expect(parseToolPayload(SHOW_BLOCK_CONTRACT, output)).toBeNull();
      const { container } = render(<Output tool={{ id: "m", name: piName, input: {}, output, isError: false }} />);
      expect(container.querySelector('[data-block="map"]')).toBeNull();
      expect(container.textContent).toContain('"kind":"map"');
      cleanup();
    }
    expect(requested).toHaveLength(0);
  });
});
