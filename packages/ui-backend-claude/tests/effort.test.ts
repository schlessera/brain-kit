import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
import { describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { resolveThinkingLevel } from "@schlessera/brain-ui-sdk/server";
import type { ServerMessage, ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import { createClaudeBackend } from "../src/backend.js";
import { backendModule } from "../src/module.js";
import { DEFAULT_PROFILES, defineProfiles } from "../src/profiles.js";

function harness(profiles = () => DEFAULT_PROFILES) {
  const calls: Options[] = [];
  const frames: ServerMessage[] = [];
  const queryFn = (({ options }: { options: Options }) => {
    calls.push(options);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "effort-session" };
      yield { type: "result", subtype: "success", session_id: "effort-session", duration_ms: 1, num_turns: 1, total_cost_usd: 0 };
    })();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/tmp/effort-test", profiles, queryFn, log() {} });
  const turn = (thinkingLevel?: ThinkingLevel, sessionId?: string) => backend.startTurn({ prompt: "hello", sessionId, thinkingLevel,
    signal: new AbortController().signal, bridge: { emit: (frame) => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } });
  return { backend, calls, frames, turn };
}

describe("Claude effort at the SDK call", () => {
  test("the built-in model and its first SDK turn use Opus 5.5 at medium", async () => {
    const h = harness();
    await h.turn();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].model).toBe("claude-opus-5-5");
    expect(h.calls[0].effort).toBe("medium");
    expect(h.backend.listProfiles()).toMatchObject([{ id: "claude", thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] }]);
  });

  test("one request overrides a profile; a resume re-reads the default and later settings", async () => {
    let level: ThinkingLevel = "low";
    const h = harness(() => defineProfiles([{ id: "claude", label: "Claude", model: "claude-opus-5-5", thinkingLevel: level }]));
    await h.turn("high");
    await h.turn(undefined, "effort-session");
    level = "medium";
    await h.turn(undefined, "effort-session");
    expect(h.calls.map((call) => call.effort)).toEqual(["high", "low", "medium"]);
    expect(h.calls[1].resume).toBe("effort-session");
  });

  test("unsupported model levels resolve downward and off/minimal map to low", async () => {
    const h = harness(() => defineProfiles([{ id: "claude", label: "Claude", model: "claude-opus-4-5" }]));
    for (const level of ["max", "xhigh", "minimal", "off"] as const) await h.turn(level);
    expect(h.calls.map((call) => call.effort)).toEqual(["high", "high", "low", "low"]);
    expect(resolveThinkingLevel("medium", ["low", "high"])).toBe("low");
  });

  test("runtime-reported managed clamping is confirmed; SDK options alone are not confirmation", async () => {
    const h = harness();
    await h.turn("max");
    expect(h.calls[0].effort).toBe("max");
    expect(h.frames.some((frame) => "effectiveThinkingLevel" in frame)).toBe(false);
    const stop = h.calls[0].hooks?.Stop?.at(-1)?.hooks[0];
    expect(stop).toBeDefined();
    await stop!({ hook_event_name: "Stop", session_id: "effort-session", effort: { level: "medium" } } as never, undefined, { signal: new AbortController().signal });
    expect(h.frames.at(-1)).toMatchObject({ type: "status", thinkingLevel: "max", effectiveThinkingLevel: "medium" });
  });
});

test("Claude module default precedence and uncached saved overrides", async () => {
  let saved: Record<string, string> = {};
  const parsed = backendModule.profileSchema.parse(null, { occupiedProfiles: [] });
  if (!parsed.ok) throw new Error("builtin profile did not parse");
  const resolved = await backendModule.resolveFromEnv({ brainPath: "/tmp/effort-test", config: { defaultThinkingLevel: "high" },
    profiles: parsed.profiles, confirmBashPatterns: null, settings: { getThinkingOverrides: () => saved } });
  if (!resolved.ok) throw resolved.error;
  expect(await resolved.value.backend.listProfiles()).toMatchObject([{ thinkingLevel: "high" }]);
  saved = { claude: "low" };
  expect(await resolved.value.backend.listProfiles()).toMatchObject([{ thinkingLevel: "low" }]);
  saved = {};
  expect(await resolved.value.backend.listProfiles()).toMatchObject([{ thinkingLevel: "high" }]);
});

mockWorkerHostForSdkStream();
