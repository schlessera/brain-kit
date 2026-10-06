/**
 * The four ask tools key their request by the model's tool_use id (#910).
 *
 * A card rebuilt from `session_history` only knows the tool call's id. A live
 * card used a random id, so a history card answered a request the host never
 * registered, and the answer was dropped. This runs the REAL Claude Code CLI
 * that the lockfile installs against a scripted model on loopback. The model
 * asks for each tool once, with a known tool_use id. The test then asserts
 * that the host bridge saw exactly that id. Nothing here proves the id with a
 * stub of the SDK: the property is what the runtime puts into a `tools/call`.
 *
 * Keyless: the credentials are bogus and the only server is 127.0.0.1.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { createBrainUiMcpServer } from "../src/ask-user-tool";

interface PlannedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

const CALLS: PlannedCall[] = [
  {
    id: "toolu_ithaca_ask",
    name: "mcp__brain-ui__ask_user",
    input: {
      questions: [
        {
          question: "Which harbour does the fleet make for first?",
          header: "Harbour",
          multiSelect: false,
          options: [
            { label: "Ithaca", description: "Home, past the straits" },
            { label: "Pylos", description: "Nestor’s court" },
          ],
        },
      ],
    },
  },
  {
    id: "toolu_ithaca_list",
    name: "mcp__brain-ui__ask_user_list",
    input: {
      prompt: "Which stores are aboard?",
      scale: [{ label: "Aboard" }, { label: "Missing" }],
      items: [
        { id: "oars", label: "Spare oars" },
        { id: "wine", label: "Wine from Maron" },
      ],
    },
  },
  {
    id: "toolu_ithaca_rank",
    name: "mcp__brain-ui__ask_user_rank",
    input: {
      prompt: "Rank the landings",
      items: [
        { id: "aeolia", label: "Aeolia" },
        { id: "scheria", label: "Scheria" },
      ],
    },
  },
  {
    id: "toolu_ithaca_form",
    name: "mcp__brain-ui__ask_user_form",
    input: {
      prompt: "Plan the crossing",
      nodes: [
        {
          id: "course",
          kind: "single",
          prompt: "Which course?",
          options: [{ label: "Coast" }, { label: "Open sea" }],
        },
      ],
    },
  },
];

function sse(events: unknown[]): Response {
  const body = events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function reply(block: unknown, stopReason: string, delta?: unknown): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "claude-probe",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    ...(delta ? [{ type: "content_block_delta", index: 0, delta }] : []),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

let server: ReturnType<typeof Bun.serve>;
let pending: PlannedCall[] = [];
const offered: string[][] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/messages") return Response.json({});
      const body = (await req.json()) as { tools?: Array<{ name: string }> };
      const names = (body.tools ?? []).map((t) => t.name);
      const next = pending[0];
      // Side requests (titles, summaries) offer no tools; answer them plainly.
      if (!next || !names.includes(next.name)) return reply({ type: "text", text: "" }, "end_turn", { type: "text_delta", text: "ok" });
      offered.push(names);
      pending.shift();
      return reply({ type: "tool_use", id: next.id, name: next.name, input: {} }, "tool_use", {
        type: "input_json_delta",
        partial_json: JSON.stringify(next.input),
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

test("each ask tool hands the bridge the tool_use id the model sent", async () => {
  pending = [...CALLS];
  const seen: Array<{ tool: string; requestId: string }> = [];
  const mcp = createBrainUiMcpServer({
    askUser: async (requestId, questions) => {
      seen.push({ tool: "ask_user", requestId });
      return { answers: { [questions[0]!.question]: "Ithaca" } };
    },
    askUserList: async (requestId) => {
      seen.push({ tool: "ask_user_list", requestId });
      return { answers: { oars: "Aboard", wine: "Missing" } };
    },
    askUserRank: async (requestId) => {
      seen.push({ tool: "ask_user_rank", requestId });
      return { order: ["scheria", "aeolia"], unchanged: false };
    },
    askUserForm: async (requestId) => {
      seen.push({ tool: "ask_user_form", requestId });
      return { answers: { course: "Coast" } };
    },
  });
  const home = mkdtempSync(join(tmpdir(), "ask-request-id-"));
  const toolUses: string[] = [];
  let resultSubtype: string | undefined;
  try {
    const stream = query({
      prompt: "Ask the planned questions.",
      options: {
        cwd: home,
        settingSources: [],
        maxTurns: CALLS.length + 2,
        model: "claude-sonnet-4-6",
        allowedTools: CALLS.map((c) => c.name),
        mcpServers: { "brain-ui": mcp },
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${"o".repeat(95)}AA`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    }) as AsyncIterable<SDKMessage>;
    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const part of message.message.content) {
          if (part.type === "tool_use") toolUses.push(part.id);
        }
      }
      if (message.type === "result") {
        resultSubtype = message.subtype;
        break;
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // The runtime really issued every planned call: the assertion below is
  // about ids it delivered, not about calls that never happened.
  expect(resultSubtype).toBe("success");
  expect(toolUses).toEqual(CALLS.map((c) => c.id));
  expect(seen.map((s) => s.tool)).toEqual(["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"]);
  expect(seen.map((s) => s.requestId)).toEqual(CALLS.map((c) => c.id));
}, 60_000);
