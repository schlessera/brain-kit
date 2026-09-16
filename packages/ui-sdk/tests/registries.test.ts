import { afterEach, describe, expect, test } from "bun:test";

import {
  createToolRendererRegistry,
  registerToolRenderers,
  resolveToolRenderer,
  resetToolRenderers,
  type RendererPack,
  type ToolCallView,
} from "../src/client/renderers";
import {
  createAsrClient,
  registerAsrClient,
  resetAsrClients,
  speechUiHints,
  type AsrClient,
} from "../src/client/asr";
import type { VoiceSessionResponse } from "../src/protocol";

afterEach(() => {
  resetToolRenderers();
  resetAsrClients();
});

function call(name: string, input: Record<string, unknown> = {}): ToolCallView {
  return { id: "t1", name, input };
}

describe("tool-renderer resolution order", () => {
  test("backend-scoped exact beats global exact beats predicate", () => {
    const scoped = { match: "bash" };
    const global = { match: "bash" };
    const predicate = {
      match: (tool: ToolCallView) => ("command" in tool.input ? 5 : 0),
    };
    registerToolRenderers({ backend: "pi", renderers: [scoped] });
    registerToolRenderers({ renderers: [global] });
    registerToolRenderers({ renderers: [predicate] });

    expect(resolveToolRenderer(call("bash", { command: "ls" }), "pi")).toBe(scoped);
    expect(resolveToolRenderer(call("bash", { command: "ls" }), "claude")).toBe(global);
  });

  test("case-sensitive names keep cross-backend packs apart (bash vs Bash)", () => {
    const piBash = { match: "bash" };
    const claudeBash = { match: "Bash" };
    registerToolRenderers({ backend: "pi", renderers: [piBash] });
    registerToolRenderers({ backend: "claude", renderers: [claudeBash] });

    expect(resolveToolRenderer(call("bash"), "pi")).toBe(piBash);
    expect(resolveToolRenderer(call("Bash"), "claude")).toBe(claudeBash);
    expect(resolveToolRenderer(call("Bash"), "pi")).toBeNull();
  });

  test("highest-scoring predicate wins; zero passes", () => {
    const diffish = {
      match: (tool: ToolCallView) =>
        "old_string" in tool.input && "new_string" in tool.input ? 10 : 0,
    };
    const fileish = {
      match: (tool: ToolCallView) => ("file_path" in tool.input ? 5 : 0),
    };
    registerToolRenderers({ renderers: [fileish, diffish] });

    const edit = call("mystery_edit", {
      file_path: "a.md",
      old_string: "x",
      new_string: "y",
    });
    expect(resolveToolRenderer(edit, "pi")).toBe(diffish);
    expect(resolveToolRenderer(call("unknown", {}), "pi")).toBeNull();
  });
});

describe("registry instancing and pack identity", () => {
  test("registering the same pack twice does not stack its predicates", () => {
    const registry = createToolRendererRegistry();
    let calls = 0;
    const pack: RendererPack = {
      renderers: [
        {
          match: () => {
            calls += 1;
            return 1;
          },
        },
      ],
    };
    registry.register(pack);
    registry.register(pack);
    registry.resolve(call("anything"), "pi");
    expect(calls).toBe(1);
    expect(registry.has(pack)).toBe(true);
  });

  test("reset clears the registered-pack set, so the same pack registers again", () => {
    const registry = createToolRendererRegistry();
    const pack: RendererPack = { renderers: [{ match: "bash" }] };
    registry.register(pack);
    registry.reset();
    expect(registry.has(pack)).toBe(false);
    expect(registry.resolve(call("bash"), "pi")).toBeNull();

    registry.register(pack);
    expect(registry.resolve(call("bash"), "pi")).toBe(pack.renderers[0]!);
  });

  test("two registries do not see each other, nor the module default", () => {
    const a = createToolRendererRegistry();
    const b = createToolRendererRegistry();
    const only = { match: "bash" };
    a.register({ renderers: [only] });

    expect(a.resolve(call("bash"), "pi")).toBe(only);
    expect(b.resolve(call("bash"), "pi")).toBeNull();
    expect(resolveToolRenderer(call("bash"), "pi")).toBeNull();
  });
});

describe("asr client registry", () => {
  const session: VoiceSessionResponse = {
    providerId: "webspeech",
    url: "",
    expiresAt: Date.now() + 60_000,
    capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false },
  };

  test("factory dispatch by providerId", () => {
    const client: AsrClient = { start: async () => {}, stop: () => {}, drainAndStop: async () => {} };
    registerAsrClient("webspeech", () => client);
    expect(createAsrClient({ session, onEvent: () => {}, onError: () => {} })).toBe(client);
  });

  test("unknown provider throws with the registered list", () => {
    expect(() =>
      createAsrClient({
        session: { ...session, providerId: "missing" },
        onEvent: () => {},
        onError: () => {},
      })
    ).toThrow(/No AsrClient registered .* none/);
  });

  test("speechUiHints derives degradation from capabilities", () => {
    expect(speechUiHints(session.capabilities)).toEqual({
      showPartials: true,
      needsManualStop: true,
      fetchKeyterms: false,
    });
  });
});
