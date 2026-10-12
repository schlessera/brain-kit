/** Real installed CLI file tools, a scripted loopback model, and fictional credentials only. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createKeyedLock, type ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPermissionWiring } from "../src/permission-hooks";
import { createTurnLockBinding } from "../src/turn-lock";
import { StreamAdapter } from "../src/stream-adapter";
import { MEASURED_RUNTIME } from "../src/measured-runtime";

function reply(call?: { name: string; input: Record<string, unknown>; id: string }): Response {
  const events: unknown[] = [{ type: "message_start", message: { id: "msg_ithaca", type: "message", role: "assistant", model: "claude-probe", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: call.id, name: call.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  return new Response(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

for (const toolName of ["Write", "Edit"] as const) for (const mode of ["stale", "cached", "fresh"] as const) test(`real Claude ${toolName} ${mode === "fresh" ? "recovers after a fresh read" : mode === "cached" ? "does not refresh a hash from a cached unchanged read" : "refuses a byte-stale file even when its mtime was preserved"}`, async () => {
  const reread = mode !== "stale", recovered = mode === "fresh";
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-stale-")), brain = join(root, "brain"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(home);
  const path = join(brain, "loom.md"), before = "Penelope weaves.\n", peer = "Penelope sleeps.\n";
  writeFileSync(path, before); utimesSync(path, new Date("2026-07-12T00:00:00Z"), new Date("2026-07-12T00:00:00Z"));
  const stamp = statSync(path);
  const calls = [{ name: "Read", input: { file_path: path }, id: "toolu_ithaca_read" },
    { name: toolName, input: toolName === "Write" ? { file_path: path, content: "Athena charts.\n" } : { file_path: path, old_string: "Penelope", new_string: "Odysseus" }, id: "toolu_ithaca_write" }];
  if (reread) calls.splice(1, 0, { name: "Read", input: { file_path: path }, id: "toolu_ithaca_reread" });
  let sent = 0, reads = 0, rereadContent: string | undefined, nativeDenial = false, version: string | undefined;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
    const body = await request.json() as { tools?: { name: string }[] };
    const call = calls[sent];
    if (!call || !body.tools?.some(tool => tool.name === call.name)) return reply();
    sent++; return reply(call);
  } });
  const frames: ServerMessage[] = [], lock = createTurnLockBinding({ turn: { ended: false, pendingReleases: new Map() }, writeLock: createKeyedLock(), lockWaitMs: 1000, log: () => {} });
  const wiring = createPermissionWiring({ req: { prompt: "Return to Ithaca.", signal: controller.signal,
    workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] }, bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } },
    allowedTools: ["Read", "Write", "Edit"], confirmPatterns: [], brainPath: brain, turnLock: lock, childEnv: { PATH: "/usr/bin:/bin" }, log: () => {} });
  const post = wiring.hooks!.PostToolUse![0]!.hooks[0]!;
  const recordThenPeer: HookCallback = async (...args) => {
    const result = await post(...args);
    if (args[0].hook_event_name === "PostToolUse" && args[0].tool_name === "Read") {
      reads++;
      if (reads === 2) rereadContent = (args[0].tool_response as { file?: { content?: string } }).file?.content;
      // A real other actor changes bytes, preserving mtime so a timestamp-only
      // upstream check is not mistaken for this first-party SHA-256 guard.
      if (reads === 1) { writeFileSync(path, peer); if (!recovered) utimesSync(path, stamp.atime, stamp.mtime); }
    }
    return result;
  };
  const hooks = { ...wiring.hooks, PostToolUse: [{ ...wiring.hooks!.PostToolUse![0]!, hooks: [recordThenPeer] }],
    PreToolUse: wiring.hooks!.PreToolUse!.map(group => ({ ...group, hooks: group.hooks.map(hook => (async (...args) => {
      const result = await hook(...args);
      if ("hookSpecificOutput" in result && result.hookSpecificOutput?.hookEventName === "PreToolUse" && result.hookSpecificOutput.permissionDecision === "deny" && result.hookSpecificOutput.permissionDecisionReason?.includes("changed since you read it")) nativeDenial = true;
      return result;
    }) as HookCallback) })) };
  const adapter = new StreamAdapter();
  try {
    for await (const message of query({ prompt: "Read the loom, then make the planned file change.", options: { cwd: brain, settingSources: [], maxTurns: 4, model: "claude-sonnet-4-6", permissionMode: "default", allowedTools: ["Read", "Write", "Edit"], ...wiring, hooks,
      abortController: controller, env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: process.env.PATH ?? "/usr/bin:/bin", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "odysseus-offline-only-key", ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } } }) as AsyncIterable<SDKMessage>) {
      if (message.type === "system" && message.subtype === "init") version = message.claude_code_version;
      frames.push(...adapter.adapt(message));
      if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) if (block.type === "tool_result") lock.releaseForTool(block.tool_use_id);
    }
    expect(version, "ACTUAL_INSTALLED_CLAUDE_FILE_TOOL_IDENTITY").toBe(MEASURED_RUNTIME.claudeCode);
    expect(sent).toBe(reread ? 3 : 2); expect(reads).toBe(reread ? 2 : 1);
    const expected = recovered ? (toolName === "Write" ? "Athena charts.\n" : "Odysseus sleeps.\n") : peer;
    expect(readFileSync(path, "utf8"), "CLAUDE_NATIVE_STALE_WRITE_EFFECT").toBe(expected);
    expect(nativeDenial, "FIRST_PARTY_NATIVE_SHA_DENIAL").toBe(!recovered);
    if (recovered) expect(rereadContent).toBe(peer);
    else if (reread) expect(rereadContent).toBeUndefined();
    expect(frames.find(frame => frame.type === "tool_result" && frame.toolUseId === "toolu_ithaca_write")).toMatchObject({ isError: !recovered });
  } finally { clearTimeout(timer); controller.abort(); server.stop(true); lock.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
