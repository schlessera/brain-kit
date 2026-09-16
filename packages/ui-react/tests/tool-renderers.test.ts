import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  resetToolRenderers,
  resolveToolRenderer,
  type ToolCallView,
} from "@schlessera/brain-ui-sdk/client";
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
    const renderer = resolveToolRenderer(toolCall("Bash"), "other");
    expect(renderer).toBe(GENERIC_RENDERER);
  });

  test("pi tools resolve to the pi pack, scoped away from other backends", () => {
    const bash = resolveToolRenderer(toolCall("bash"), "pi");
    expect(bash).not.toBeNull();
    expect(bash).not.toBe(GENERIC_RENDERER);
    expect(bash?.semantics?.command?.(toolCall("bash", { input: { command: "ls" } }))).toBe(
      "ls"
    );
    // Case-sensitive and backend-scoped in both directions.
    expect(resolveToolRenderer(toolCall("bash"), "claude")).toBe(GENERIC_RENDERER);
    expect(resolveToolRenderer(toolCall("Bash"), "pi")).toBe(GENERIC_RENDERER);
  });

  test("pi write tools expose touchedFile and writePath semantics", () => {
    const write = resolveToolRenderer(
      toolCall("write_file", { input: { path: "notes/a.md", content: "x" } }),
      "pi"
    );
    const tool = toolCall("write_file", { input: { path: "notes/a.md", content: "x" } });
    expect(write?.touchedFile?.(tool)).toBe("notes/a.md");
    expect(write?.semantics?.writePath?.(tool)).toBe("notes/a.md");
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

describe("registration survives a reset", () => {
  // The registry used to be latched behind a module-level `registered` boolean
  // that `resetToolRenderers()` could not clear, so ONE reset anywhere — a
  // story, a test — permanently un-registered the builtins for everything that
  // ran afterwards. Idempotence now belongs to the registry (pack identity),
  // which reset clears along with everything else.
  afterAll(() => {
    resetToolRenderers();
    registerBuiltinRenderers();
  });

  test("re-registering after a reset restores the builtins", () => {
    registerBuiltinRenderers();
    resetToolRenderers();
    expect(resolveToolRenderer(toolCall("Bash"), "claude")).toBeNull();

    registerBuiltinRenderers();
    const renderer = resolveToolRenderer(toolCall("Bash"), "claude");
    expect(renderer).not.toBeNull();
    expect(renderer).not.toBe(GENERIC_RENDERER);
  });

  test("calling it twice without a reset registers each pack once", () => {
    resetToolRenderers();
    registerBuiltinRenderers();
    registerBuiltinRenderers();
    // A duplicated generic pack would stack a second predicate; resolution
    // would still work, so the observable is that the SAME object wins.
    expect(resolveToolRenderer(toolCall("mystery"), "nobody")).toBe(GENERIC_RENDERER);
    expect(resolveToolRenderer(toolCall("Bash"), "claude")).not.toBe(GENERIC_RENDERER);
  });
});
