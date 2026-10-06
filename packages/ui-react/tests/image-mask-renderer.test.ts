// `request_image_mask` is bound through its contract like the location card:
// every spelling of the name resolves to the receipt, and the summary reads
// the parsed payload.
import { describe, test, expect, beforeAll } from "bun:test";
import { type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { resolveToolRenderer } from "../../ui-sdk/src/client/renderers.js";
import { registerBuiltinRenderers, GENERIC_RENDERER } from "../src/components/chat/renderers";

const payload = JSON.stringify({
  maskPath: "assets/images/house-mask.png",
  imagePath: "assets/images/house.png",
  bytes: 2048,
  note: "Transparent pixels mark the editable region.",
});

function call(name: string, extra: Partial<ToolCallView> = {}): ToolCallView {
  return { id: "m1", name, input: { imagePath: "assets/images/house.png" }, output: payload, ...extra };
}

describe("request_image_mask renderer", () => {
  beforeAll(() => registerBuiltinRenderers());

  test.each([
    ["request_image_mask", "pi"],
    ["mcp__brain-ui__request_image_mask", "claude"],
    ["mcp__brain_ui__request_image_mask", "claude"],
  ])("%s on %s resolves to the bound receipt", (name, backend) => {
    const renderer = resolveToolRenderer(call(name), backend);
    expect(renderer).not.toBeNull();
    expect(renderer).not.toBe(GENERIC_RENDERER);
    expect(renderer?.label).toBe("Mask");
    expect(renderer?.summary?.(call(name))).toBe("assets/images/house.png");
    expect(renderer?.meta?.(call(name))).toBe("mask assets/images/house-mask.png");
  });

  test("an errored call has no summary: the fallback states the fact instead", () => {
    const errored = call("request_image_mask", { output: "User declined", isError: true });
    const renderer = resolveToolRenderer(errored, "pi");
    expect(renderer?.summary?.(errored)).toBeNull();
  });
});
