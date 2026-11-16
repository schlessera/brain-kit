import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
/**
 * #2875: the Claude backend reports no `StartTurnRequest.toolExecution`
 * evidence. A hosted interactive Claude turn loads the brain's project
 * settings and `.mcp.json`, and the CLI keeps watching them, so no call in it
 * is proven to have run no project hook or brain-owned MCP code
 * (docs/decisions/governed-writable-workers.md, "Claude tool execution
 * evidence — 2026-11-15 (#2875)"). Every Claude result therefore stays
 * observed. This fails if any call, read or not, reports evidence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { BackendBridge, ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";

mockWorkerHostForSdkStream();

/** The calls a proven read could plausibly have covered: built-in reads, host bridge reads, and the brain's own MCP server. */
const CALLS: [id: string, name: string, input: Record<string, unknown>][] = [
  ["read-1", "Read", { file_path: "notes/loom.md" }],
  ["grep-1", "Grep", { pattern: "Penelope" }],
  ["glob-1", "Glob", { pattern: "notes/*.md" }],
  ["base-1", "mcp__brain-ui__brain_read_base", { path: "notes/loom.md" }],
  ["activity-1", "mcp__brain-ui__query_activity", {}],
  ["search-1", "mcp__brain__brain_search", { query: "loom" }],
];

function* scripted(sessionId: string) {
  yield { type: "system", subtype: "init", session_id: sessionId };
  for (const [id, name, input] of CALLS) {
    yield { type: "stream_event", session_id: sessionId, event: { type: "content_block_start", content_block: { type: "tool_use", id, name } } };
    yield { type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id, name, input }] } };
    yield { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: id, content: "Penelope weaves by day." }] } };
  }
  yield { type: "result", subtype: "success", session_id: sessionId, is_error: false, result: "done", num_turns: CALLS.length, duration_ms: 1,
    total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}

describe("Claude tool execution evidence (#2875)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "odysseus-claude-evidence-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function brain(name: string, configure: (dir: string) => void): string {
    const dir = join(root, name);
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "notes", "loom.md"), "Penelope weaves by day.\n");
    configure(dir);
    return dir;
  }

  async function run(brainPath: string) {
    const frames: ServerMessage[] = [], evidence: [string, string][] = [];
    let options: Options | undefined;
    const bridge: BackendBridge = { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) };
    const queryFn = ((params: { options?: Options }) => {
      options = params.options;
      return (async function* () { yield* scripted("ithaca-evidence"); })();
    }) as unknown as typeof query;
    const req: StartTurnRequest = { prompt: "Read the loom note.", signal: new AbortController().signal, bridge,
      toolExecution: (toolUseId, path) => { evidence.push([toolUseId, path]); } };
    await createClaudeBackend({ brainPath, queryFn }).startTurn(req);
    return { frames, evidence, options: options! };
  }

  const ithacaHooked = (dir: string) => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "node .claude/hooks/tally-suitors.mjs" }] }] },
    }));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } }));
  };

  for (const [label, configure] of [
    ["with a project hook and the brain's project MCP server", ithacaHooked],
    ["with neither configured at turn start", () => {}],
  ] as const) {
    test(`no call reports evidence ${label}`, async () => {
      const dir = brain(label.includes("hook") ? "hooked" : "bare", configure);
      const { frames, evidence, options } = await run(dir);
      // The turn really loads the brain's project settings and .mcp.json, which the CLI watches for the session.
      expect([options.cwd, options.settingSources, options.strictMcpConfig ?? false], "CLAUDE_LOADS_PROJECT_SETTINGS").toEqual([dir, ["project"], false]);
      // Every call ran to its result, so evidence had every chance to be reported.
      expect(frames.filter(frame => frame.type === "tool_result").map(frame => frame.type === "tool_result" ? frame.toolUseId : null), "CLAUDE_EVERY_RESULT_EMITTED")
        .toEqual(CALLS.map(([id]) => id));
      expect(evidence, "CLAUDE_REPORTS_NO_TOOL_EXECUTION_EVIDENCE").toEqual([]);
    });
  }
});
