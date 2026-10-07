/**
 * A voice-posture turn runs on the named voice allowlist, not the ordinary one
 * (#957; docs/decisions/voice-permission.md "The voice posture"). Enforcement
 * and no-grant alone narrow nothing when the ordinary list auto-allows Bash,
 * Write and Edit — the list itself has to change.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { BackendRequestError, type BackendBridge, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { DEFAULT_ALLOWED_TOOLS, VOICE_ALLOWED_TOOLS } from "../src/tool-policy";

const finishTurns: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of finishTurns.splice(0)) await finish();
});

async function capturedAllowlist(
  posture: Pick<StartTurnRequest, "posture" | "enforceAllowedTools" | "noGrantSurface">
): Promise<string[]> {
  let captured: Options | undefined;
  let announce!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => { announce = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const queryFn = ((params: { options?: Options }) => {
    captured = params.options!;
    announce();
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      await held;
      yield { type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/brain", queryFn, allowedTools: [...DEFAULT_ALLOWED_TOOLS], log: () => {} });
  const bridge: BackendBridge = { emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "No." }) };
  const running = backend.startTurn({ prompt: "what is on the shelf?", signal: new AbortController().signal, bridge, ...posture });
  await Promise.race([started, running.then(() => { throw new Error("Fixture ended before SDK admission"); })]);
  finishTurns.push(async () => { finish(); await running; });
  return [...(captured!.allowedTools ?? [])];
}

describe("claude: the voice posture selects VOICE_ALLOWED_TOOLS", () => {
  test("a voice turn's allowlist is the voice posture, without the ordinary write and shell tools", async () => {
    const voice = await capturedAllowlist({ posture: "voice", enforceAllowedTools: true, noGrantSurface: true });
    for (const excluded of ["Bash", "Write", "Edit", "NotebookEdit", "Agent", "Skill"]) expect(voice).not.toContain(excluded);
    expect([...new Set(voice)].sort()).toEqual([...new Set(VOICE_ALLOWED_TOOLS)].sort());
  });

  test("the same backend's ordinary enforced turn keeps its configured list", async () => {
    const ordinary = await capturedAllowlist({ enforceAllowedTools: true, noGrantSurface: true });
    expect(ordinary).toContain("Bash");
    expect(ordinary).toContain("Write");
  });

  test("a voice posture without the enforced no-grant pair is refused", async () => {
    const backend = createClaudeBackend({ brainPath: "/brain", queryFn: (() => { throw new Error("must not run"); }) as unknown as typeof query, log: () => {} });
    const bridge: BackendBridge = { emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "No." }) };
    await expect(backend.startTurn({ prompt: "x", signal: new AbortController().signal, bridge, posture: "voice", enforceAllowedTools: true }))
      .rejects.toBeInstanceOf(BackendRequestError);
  });
});
