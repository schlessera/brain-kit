import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GET_CURRENT_LOCATION_CONTRACT, type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { resetToolRenderers, resolveToolRenderer } from "../../ui-sdk/src/client/renderers.js";
import { boundToolNames } from "../src/components/chat/renderers/bind.js";
import {
  registerBuiltinRenderers,
  GENERIC_RENDERER,
} from "../src/components/chat/renderers/index.js";

// Rendering the bound component needs a DOM, and this repo keeps every render
// test in tests/render/render-smoke.test.tsx (see tests/render/dom.ts for why).
// What is asserted here is resolution and the payload-reading accessors, which
// are pure.

const FIX = {
  latitude: 38.3653,
  longitude: 20.7169,
  accuracyMeters: 42,
  place: "Vathy",
  address: "Vathy, Ithaca, Greece",
  retrievedAt: "2026-07-12T09:15:00.000Z",
};

function call(name: string, output?: string, isError?: boolean): ToolCallView {
  return {
    id: "t1",
    name,
    input: {},
    ...(output === undefined ? {} : { output }),
    ...(isError ? { isError } : {}),
  };
}

describe("a contract-bound renderer resolves under every backend's name", () => {
  beforeAll(() => {
    resetToolRenderers();
    registerBuiltinRenderers();
  });
  afterAll(() => {
    resetToolRenderers();
    registerBuiltinRenderers();
  });

  test("the bare name, the MCP name and the pre-rename MCP name all bind", () => {
    // The gap this closes: the location result had a renderer only under
    // Claude's MCP-prefixed name, so the identical tool on pi rendered as raw
    // JSON, and a resumed transcript carrying the old prefix did too.
    expect(boundToolNames(GET_CURRENT_LOCATION_CONTRACT)).toEqual([
      "get_current_location",
      "mcp__brain-ui__get_current_location",
      "mcp__brain_ui__get_current_location",
    ]);
    for (const name of boundToolNames(GET_CURRENT_LOCATION_CONTRACT)) {
      for (const backend of ["claude", "pi", "someone-else"]) {
        const renderer = resolveToolRenderer(call(name), backend);
        expect(renderer).not.toBeNull();
        expect(renderer).not.toBe(GENERIC_RENDERER);
      }
    }
  });

  test("the summary and meta lines read the parsed payload", () => {
    const tool = call("get_current_location", JSON.stringify(FIX));
    const renderer = resolveToolRenderer(tool, "pi")!;
    expect(renderer.summary?.(tool)).toBe("Vathy");
    expect(renderer.meta?.(tool)).toBe("±42 m");
    expect(renderer.label).toBe("Location");
  });

  test("an unparseable output leaves summary and meta null rather than throwing", () => {
    const denied = call(
      "get_current_location",
      "User denied the geolocation request.",
      true
    );
    const renderer = resolveToolRenderer(denied, "claude")!;
    expect(renderer.summary?.(denied)).toBeNull();
    expect(renderer.meta?.(denied)).toBeNull();
  });

  test("a payload missing the optional place falls back to its address", () => {
    const { place: _place, ...noPlace } = FIX;
    const tool = call("get_current_location", JSON.stringify(noPlace));
    const renderer = resolveToolRenderer(tool, "pi")!;
    expect(renderer.summary?.(tool)).toBe("Vathy, Ithaca, Greece");
  });
});
