/**
 * The turn runner's subscription gate, driven by query doubles that DO pull
 * the prompt (#253). The live half — what the real CLI sends — is
 * subscription-billing.test.ts; this covers the orderings a live run cannot
 * pin down: a stream that keeps talking after a refusal, and a cancellation
 * that lands while the handshake is still pending.
 */

import { describe, expect, test } from "bun:test";
import type { AccountInfo, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendBridge, ServerMessage } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";

interface Double {
  queryFn: typeof query;
  /** The user messages the gate released to the "CLI". */
  released: SDKUserMessage[];
}

/**
 * A query that pulls every prompt message the gate releases, then yields
 * `after` — whether or not anything was released.
 */
function double(
  init: () => Promise<{ account: AccountInfo }>,
  after: unknown[],
  settings: (() => Promise<unknown>) | null = async () => ({ effective: {}, sources: [] })
): Double {
  const released: SDKUserMessage[] = [];
  const queryFn = ((params: { prompt: string | AsyncIterable<SDKUserMessage> }) => ({
    initializationResult: init,
    ...(settings ? { getSettings: settings } : {}),
    async *[Symbol.asyncIterator]() {
      if (typeof params.prompt !== "string") {
        for await (const message of params.prompt) released.push(message);
      }
      yield* after;
    },
  })) as unknown as typeof query;
  return { queryFn, released };
}

async function turn(
  d: Double,
  signal = new AbortController().signal,
  sessionId?: string
): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = [];
  const bridge: BackendBridge = {
    emit: (message) => frames.push(message),
    requestPermission: async () => ({ behavior: "allow" }),
  };
  const backend = createClaudeBackend({
    brainPath: "/brain",
    queryFn: d.queryFn,
    log: () => {},
  });
  await backend.startTurn({ prompt: "hi", signal, bridge, ...(sessionId ? { sessionId } : {}) });
  return frames;
}

const success = {
  type: "result",
  subtype: "success",
  session_id: "s1",
  is_error: false,
  result: "ok",
  total_cost_usd: 0,
  duration_ms: 1,
  num_turns: 1,
  usage: {},
  modelUsage: {},
};

describe("the subscription gate", () => {
  test("a subscription account releases the prompt", async () => {
    const d = double(
      async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }),
      []
    );
    await turn(d);
    expect(d.released).toHaveLength(1);
    expect(d.released[0]!.message.content).toBe("hi");
  });

  test("a refused turn stays refused when the stream keeps talking", async () => {
    const d = double(
      async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: "ANTHROPIC_API_KEY" } }),
      [{ type: "system", subtype: "init", session_id: "s1" }, success]
    );
    const frames = await turn(d);

    expect(d.released).toEqual([]);
    const failures = frames.filter((f) => f.type === "error" && f.code === "CLAUDE_AUTH");
    expect(failures).toHaveLength(1);
    expect(frames.at(-1)).toBe(failures[0]!);
    expect(frames.some((f) => f.type === "result" && f.outcome === "success")).toBe(false);
  });

  test("a resumed session is gated too, and its refusal still ends the turn", async () => {
    const d = double(async () => ({ account: { tokenSource: "none", apiProvider: "firstParty" } }), []);
    const frames = await turn(d, new AbortController().signal, "existing-session");

    expect(d.released).toEqual([]);
    expect(frames.filter((f) => f.type === "error" && f.code === "CLAUDE_AUTH")).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ type: "result", outcome: "error", sessionId: "existing-session" });
  });

  test("a cancellation during the handshake is a cancelled turn, even if the stream then reports success", async () => {
    const host = new AbortController();
    const d = double(
      () =>
        new Promise((_resolve, reject) => {
          host.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          setTimeout(() => host.abort(), 5);
        }),
      [{ type: "system", subtype: "init", session_id: "s1" }, success]
    );
    const frames = await turn(d, host.signal);

    expect(d.released).toEqual([]);
    expect(frames.some((f) => f.type === "error" && (f.code === "CLAUDE_ERROR" || f.code === "CLAUDE_AUTH"))).toBe(false);
    expect(frames.some((f) => f.type === "result" && f.outcome === "success")).toBe(false);
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "CANCELLED" });
  });

  test("settings the CLI reports with a helper refuse a subscription account", async () => {
    const d = double(
      async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }),
      [],
      async () => ({
        effective: { apiKeyHelper: "" },
        sources: [{ source: "policySettings", settings: { apiKeyHelper: "sleep 1; echo key" } }],
      })
    );
    const frames = await turn(d);

    expect(d.released).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "CLAUDE_AUTH" });
  });

  test("a CLI that cannot report its settings is refused, not trusted", async () => {
    const d = double(
      async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }),
      [],
      null
    );
    const frames = await turn(d);

    expect(d.released).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "CLAUDE_AUTH" });
  });

  test("a handshake that fails on its own is a CLAUDE_ERROR, and nothing is released", async () => {
    const d = double(async () => {
      throw new Error("spawn failed");
    }, []);
    const frames = await turn(d);

    expect(d.released).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "CLAUDE_ERROR" });
  });
});
