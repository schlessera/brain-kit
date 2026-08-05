import { describe, test, expect, beforeAll } from "bun:test";
import { resolveToolRenderer, type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import {
  registerBuiltinRenderers,
  GENERIC_RENDERER,
} from "../src/components/chat/renderers";

function toolCall(name: string, extra: Partial<ToolCallView> = {}): ToolCallView {
  return { id: "t1", name, input: {}, ...extra };
}

describe("tool-renderer resolution", () => {
  beforeAll(() => registerBuiltinRenderers());

  test("a Claude tool resolves to its scoped renderer, not the generic one", () => {
    const renderer = resolveToolRenderer(toolCall("Bash"), "claude");
    expect(renderer).not.toBeNull();
    expect(renderer).not.toBe(GENERIC_RENDERER);
    expect(renderer?.icon).toBeDefined();
    expect(renderer?.Input).toBeDefined();
  });

  test("the Claude pack is backend-scoped: 'Bash' on another backend falls through", () => {
    // The generic (shape-sniffing) predicate claims it instead.
    const renderer = resolveToolRenderer(toolCall("Bash"), "pi");
    expect(renderer).toBe(GENERIC_RENDERER);
  });

  test("an unknown tool name falls back to the generic renderer", () => {
    const renderer = resolveToolRenderer(toolCall("some_unknown_tool"), "claude");
    expect(renderer).toBe(GENERIC_RENDERER);
  });

  test("the generic renderer always matches (predicate never returns 0)", () => {
    const renderer = resolveToolRenderer(toolCall("x", { input: { foo: 1 } }), "");
    expect(renderer).toBe(GENERIC_RENDERER);
  });
});
