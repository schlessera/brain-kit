/** #587: capture the installed CLI's request using a loopback scripted model.
 * This observes serialization, not model choice or model quality. No real
 * credential is used. Run in an explicitly offline namespace when testing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options, SDKMessage, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createFixture, fixtureTurn, connectBrainSurface, installedRuntime } from "./turn-surface-fixture.js";
import { type Peer } from "./turn-surface-routing.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { gatedSurfaceServer, startOverlappedTurn, type SurfaceDecision } from "./turn-surface-overlap.js";

export const SURFACE_MODEL = "claude-sonnet-5-5";
export interface CapturedRequest {
  model: string;
  system: unknown;
  tools: Array<{ name: string; description?: string; input_schema?: unknown; defer_loading?: boolean }>;
  messages: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
}

/** A second transport delegates to the original core executors. */
export function coreSdkServer(peer: Peer) {
  const instance = new McpServer({ name: "brain", version: "0.1.0" }, {
    capabilities: { tools: {} }, instructions: peer.client.getInstructions(),
  });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: peer.tools.map(({ id: _id, serverName: _server, ...tool }) => ({
      ...tool, _meta: { ...tool._meta, "anthropic/alwaysLoad": true },
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, request => peer.client.callTool(request.params));
  return { type: "sdk" as const, name: "brain", instance };
}

function scriptedReply(model: string, call?: { name: string; input: unknown }, sequence = 0): Response {
  const events = [
    { type: "message_start", message: { id: `msg_surface_control_${sequence}`, type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: call
      ? { type: "tool_use", id: `tool_surface_${call.name}_${sequence}`, name: call.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: call
      ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
      : { type: "text_delta", text: "Offline serialization control." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export async function captureSurface(control?: {
  decision: Promise<SurfaceDecision>;
  onSpawn?: () => void;
  recoverTool?: string;
  skillCatalogue?: readonly string[];
  guard?: (root: string) => HookCallback;
  readGuardControl?: boolean;
  corpus?: boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), "turn-surface-home-"));
  mkdirSync(join(home, ".claude"));
  const fixture = createFixture({ corpus: control?.corpus });
  const prepared = await fixtureTurn(fixture.root, "Explain what a mast does.", "normal", undefined, { productionDefaults: true });
  const brain = await connectBrainSurface(fixture.root);
  const core = control ? gatedSurfaceServer("brain", {
    ...brain, tools: brain.tools.map(tool => ({ ...tool, _meta: { ...tool._meta, "anthropic/alwaysLoad": true } })),
  }, control.decision) : coreSdkServer(brain);
  const bridge = control ? gatedSurfaceServer("brain-ui", prepared.peer, control.decision) : undefined;
  const outside = join(home, "controlled-outside.txt");
  writeFileSync(outside, "OUTSIDE CONTROLLED CONTENT MUST NEVER REACH THE MODEL");
  const calls = control?.readGuardControl ? [
    { name: "Read", input: { file_path: outside } },
    { name: "Read", input: { file_path: join(fixture.root, "me/identity.md") } },
  ] : control?.recoverTool ? [{ name: "ToolSearch", input: { query: `select:${control.recoverTool}` } }] : [];
  const bodies: CapturedRequest[] = [];
  let mainRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/v1/messages") return Response.json({});
    const body = await request.json() as CapturedRequest;
    // Credentials, headers and filesystem locations are never serialized.
    bodies.push(body);
    const isMain = body.tools?.some(tool => tool.name === "Read");
    const call = isMain ? calls[mainRequests++] : undefined;
    return scriptedReply(body.model, call, bodies.length);
  } });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);
  let completion: string | undefined;
  let cliVersion: string | undefined;
  const frames: SDKMessage[] = [];
  let overlapped: Awaited<ReturnType<typeof startOverlappedTurn>> | undefined;
  try {
    const sdkEntry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src"));
    const { query } = await import(sdkEntry) as typeof import("@anthropic-ai/claude-agent-sdk");
    const options: Options = {
      ...prepared.turn.options, model: SURFACE_MODEL, maxTurns: calls.length + 1, persistSession: false,
      abortController,
      mcpServers: { brain: core, ...prepared.turn.options.mcpServers, ...(bridge ? { "brain-ui": bridge } : {}) },
      // Capture uses bogus API auth on loopback, not the subscription gate.
      settings: { apiKeyHelper: "", env: {}, autoMemoryEnabled: false },
      env: {
        PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "offline-surface-control",
        CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_CUSTOM_HEADERS: "",
        CLAUDE_CODE_HOST_CREDS_FILE: "", CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_TOOL_SEARCH: "true",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: SURFACE_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: SURFACE_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: SURFACE_MODEL, CLAUDE_CODE_SUBAGENT_MODEL: SURFACE_MODEL,
      },
      ...(control?.onSpawn ? { spawnClaudeCodeProcess: spawnOptions => {
        control.onSpawn!();
        return spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd,
          env: spawnOptions.env, stdio: ["pipe", "pipe", "pipe"], signal: spawnOptions.signal });
      } } : {}),
    };
    if (control?.guard) options.hooks = { ...options.hooks,
      PreToolUse: [...(options.hooks?.PreToolUse ?? []), { hooks: [control.guard(fixture.root)] }],
    };
    if (control) {
      overlapped = await startOverlappedTurn({ options, parkingDirectory: home, projectDirectory: fixture.root,
        prompt: String(prepared.turn.prompt), decision: control.decision,
        skillCatalogue: control.skillCatalogue,
        beforeClaim: decision => { if (decision.routed && decision.arm === "hard-prune") fixture.pruneSkills(decision.skills); },
      });
    }
    const stream = overlapped?.query ?? query({ prompt: prepared.turn.prompt, options });
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      frames.push(message);
      if (message.type === "system" && message.subtype === "init") cliVersion = message.claude_code_version;
      if (message.type === "result") completion = message.subtype;
    }
    if (completion !== "success") throw new Error(`capture did not complete: ${completion ?? "missing result"}`);
    // Main requests include the real bridge/core tools; auxiliary requests do
    // not establish the prompt surface being measured.
    const request = bodies.find(body => body.tools?.some(tool => tool.name === "Read")
      && JSON.stringify(body.messages).includes("Explain what a mast does."));
    if (!request) throw new Error("capture did not observe the actual bridge request");
    return { evidence: "offline-installed-cli-serialization", runtime: installedRuntime(), cliVersion,
      fixtureSkills: fixture.skills, request, frames,
      requests: bodies.filter(body => body.tools?.some(tool => tool.name === "Read")) };
  } finally {
    clearTimeout(timeout); overlapped?.spare.close(); server.stop(true);
    await bridge?.instance.close();
    await core.instance.close(); await brain.client.close(); await prepared.close();
    fixture.close(); rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") throw new Error("usage: capture-turn-surface.ts --out request.json");
  // Await the file write: exiting after a large console.log can lose the
  // trailing bytes when stdout is a pipe.
  await Bun.write(args[1], JSON.stringify(await captureSurface(), null, 2) + "\n");
}
