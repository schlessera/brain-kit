import { expect, test } from "bun:test";
import type { ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import type { PiSessionLike } from "../src/backend-options.js";
import { createPiBackend } from "../src/backend.js";
import { makeEmptyBrain } from "./helpers.js";
import { makeMockBridge } from "./mock-bridge.js";

test("Pi sets effort before each prompt and restores current defaults on resident and reopened resumes", async () => {
  const brain = makeEmptyBrain();
  let defaultLevel: ThinkingLevel = "medium";
  let current: ThinkingLevel = "high";
  const prompted: ThinkingLevel[] = [];
  const persisted: Array<boolean | undefined> = [];
  const session: PiSessionLike = {
    sessionId: "effort-session", get thinkingLevel() { return current; },
    getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    setThinkingLevel(level, options) { current = level; persisted.push(options?.persist); },
    subscribe: () => () => {}, async prompt() { prompted.push(current); },
    async abort() {}, getSessionStats: () => ({ cost: 0 }), dispose() {},
  };
  const factory = { newSession: async () => session, openSession: async () => session };
  const options = { brainPath: brain.root, sessionFactory: factory,
    profiles: () => [{ id: "test", label: "Test", model: "test", thinkingLevel: defaultLevel }] };
  try {
    const backend = createPiBackend(options);
    const mock = makeMockBridge();
    const req = { prompt: "hello", profileId: "test", signal: new AbortController().signal, bridge: mock.bridge };
    await backend.startTurn({ ...req, thinkingLevel: "max" });
    await backend.startTurn({ ...req, sessionId: session.sessionId });
    defaultLevel = "low";
    await createPiBackend(options).startTurn({ ...req, sessionId: session.sessionId });
    expect(prompted).toEqual(["high", "medium", "low"]);
    expect(persisted).toEqual([false, false, false]);
    expect(mock.emitted.find((frame) => frame.type === "session_info")).toMatchObject({ thinkingLevel: "max", effectiveThinkingLevel: "high" });
  } finally { brain.cleanup(); }
});


test("a resume without profileId resets from the actual model's current profile", async () => {
  const brain = makeEmptyBrain();
  let saved: ThinkingLevel = "low";
  let current: ThinkingLevel = "high";
  const prompted: ThinkingLevel[] = [];
  const session: PiSessionLike = {
    sessionId: "model-default-session", model: { id: "second-model", provider: "test" } as PiSessionLike["model"],
    get thinkingLevel() { return current; }, getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    setThinkingLevel(level) { current = level; }, subscribe: () => () => {},
    async prompt() { prompted.push(current); }, async abort() {}, getSessionStats: () => ({ cost: 0 }), dispose() {},
  };
  const backend = createPiBackend({ brainPath: brain.root,
    sessionFactory: { newSession: async () => session, openSession: async () => session },
    profiles: () => [{ id: "first", label: "First", vendor: "test", model: "first-model", thinkingLevel: "high" },
      { id: "second", label: "Second", vendor: "test", model: "second-model", thinkingLevel: saved }],
  });
  const { bridge } = makeMockBridge();
  const req = { sessionId: session.sessionId, prompt: "hello", signal: new AbortController().signal, bridge };
  try {
    await backend.startTurn({ ...req, thinkingLevel: "max" });
    await backend.startTurn(req);
    saved = "medium";
    await backend.startTurn(req);
    expect(prompted).toEqual(["high", "low", "medium"]);
  } finally { brain.cleanup(); }
});
