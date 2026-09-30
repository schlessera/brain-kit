import { describe, expect, test } from "bun:test";
import type { ConfirmPatternSource, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend, type PiSessionLike } from "../src/backend";
import { makeEmptyBrain } from "./helpers";

async function constructAndRun(confirmBashPatterns?: readonly ConfirmPatternSource[]) {
  const brain = makeEmptyBrain();
  let sessions = 0;
  let prompts = 0;
  const frames: ServerMessage[] = [];
  const diagnostics: Array<{ pattern?: unknown; error?: unknown }> = [];
  const session = (): PiSessionLike => ({
    sessionId: `confirm-${++sessions}`,
    subscribe: () => () => {},
    prompt: async () => { prompts++; },
    abort: async () => {},
    getSessionStats: () => ({ cost: 0 }),
    dispose() {},
  });
  let backend: ReturnType<typeof createPiBackend> | undefined;
  let constructionError: unknown;
  try {
    try {
      backend = createPiBackend({
        brainPath: brain.root,
        ...(confirmBashPatterns === undefined ? {} : { confirmBashPatterns }),
        sessionFactory: { newSession: async () => session(), openSession: async () => session() },
        log: (_level, _message, attrs) => diagnostics.push(attrs ?? {}),
      });
    } catch (error) {
      constructionError = error;
    }
    // Removing the compiler guard makes this exercise the real turn runner.
    if (backend) {
      await backend.startTurn({
        prompt: "test", signal: new AbortController().signal,
        bridge: {
          emit: (frame) => frames.push(frame),
          requestPermission: async () => ({ behavior: "deny", message: "No." }),
        },
      });
    }
    return { constructionError, sessions, prompts, frames, diagnostics };
  } finally {
    brain.cleanup();
  }
}

describe("pi confirmation-pattern initialization", () => {
  test("an all-invalid list rejects construction before a session or prompt runs", async () => {
    const result = await constructAndRun(["("]);
    expect(result.constructionError).toBeInstanceOf(Error);
    expect((result.constructionError as Error).message).toMatch(/confirmBashPatterns.*BRAIN_UI_CONFIRM_BASH/);
    expect(result.sessions).toBe(0);
    expect(result.prompts).toBe(0);
    expect(result.frames).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ pattern: "(", error: expect.any(String) });
  });

  for (const [name, patterns] of [
    ["missing patterns use defaults", undefined],
    ["explicit [] disables confirmation", []],
    ["mixed patterns retain their valid entries", ["(", { pattern: "deploy", effect: "ship a build" }]],
  ] as const) {
    test(`${name} and the scripted runtime runs`, async () => {
      const result = await constructAndRun(patterns);
      expect(result.constructionError).toBeUndefined();
      expect(result.sessions).toBe(1);
      expect(result.prompts).toBe(1);
      expect(result.frames.find((frame) => frame.type === "result")).toMatchObject({ outcome: "success" });
      if (patterns?.length) {
        expect(result.diagnostics.filter((entry) => entry.pattern === "(")).toHaveLength(1);
      }
    });
  }
});
