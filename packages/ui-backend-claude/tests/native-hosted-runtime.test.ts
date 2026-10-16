/** Production SDK options and isolated worker, real CLI tools, scripted loopback inference. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createKeyedLock, type ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createClaudeSdkTurn } from "../src/sdk-options";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture";
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

let registeredTools: string | undefined;

for (const toolName of ["Write", "Edit", "NotebookEdit"] as const) for (const mode of ["stale", "fresh", "strict", "voice"] as const) test(`hosted real Claude ${toolName}: ${mode}`, async () => {
  const reread = mode === "fresh", recovered = mode === "fresh";
  const refused = mode === "strict" || mode === "voice";
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-stale-")), brain = join(root, "brain"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(home);
  const notebook = (source: string) => JSON.stringify({ cells: [{ cell_type: "code", id: "loom", metadata: {}, source: [source], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  const path = join(brain, toolName === "NotebookEdit" ? "loom.ipynb" : "loom.md"), before = toolName === "NotebookEdit" ? notebook("Penelope weaves.\n") : "Penelope weaves.\n", peer = toolName === "NotebookEdit" ? notebook("Penelope sleeps.\n") : "Penelope sleeps.\n";
  writeFileSync(path, before); utimesSync(path, new Date("2026-07-12T00:00:00Z"), new Date("2026-07-12T00:00:00Z"));
  const stamp = statSync(path);
  const calls = [{ name: "Read", input: { file_path: path }, id: "toolu_ithaca_read" },
    { name: toolName, input: toolName === "Write" ? { file_path: path, content: "Athena charts.\n" } : toolName === "NotebookEdit" ? { notebook_path: path, cell_id: "loom", new_source: "Athena charts.", edit_mode: "replace" } : { file_path: path, old_string: "Penelope", new_string: "Odysseus" }, id: "toolu_ithaca_write" }];
  if (reread) calls.splice(1, 0, { name: "Read", input: { file_path: path }, id: "toolu_ithaca_reread" });
  let roster: string | undefined, sent = 0, reads = 0, rereadContent: string | undefined, authorityDenial = false, nativeDenial = false, version: string | undefined;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
    const body = await request.json() as { tools?: { name: string }[] };
    roster ??= JSON.stringify(body.tools);
    const call = calls[sent];
    if (!call || !body.tools?.some(tool => tool.name === call.name)) return reply();
    sent++; return reply(call);
  } });
  const lockState = { ended: false, pendingReleases: new Map<string, () => void>() };
  let lockHeldDuringWrite = false;
  const frames: ServerMessage[] = [], lock = createTurnLockBinding({ turn: lockState, writeLock: createKeyedLock(), lockWaitMs: 1000, log: () => {} });
  let cards = 0;
  const startupView = createFixtureWorkerStartupView(brain);
  const turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: {
    prompt: "Return to Ithaca.", signal: controller.signal,
    posture: mode === "voice" ? "voice" : undefined,
    workerStartupView: startupView,
    workerSandbox: { brain, profile: mode === "strict" ? "strict" : "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
    bridge: { emit: () => {}, applyBrain: async () => ({}), requestPermission: async () => { cards++; return { behavior: "allow" }; } },
  } as never,
    profile: { billing: "api", requiredEnvKeys: [], buildEnv: () => ({ HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: process.env.PATH ?? "/usr/bin:/bin", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "odysseus-offline-only-key", ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }) } as never,
    abortController: controller, allowedTools: ["Read", "Write", "Edit", "NotebookEdit"], confirmPatterns: [], turnLock: lock, log: () => {} });
  const wiring = turn.options;
  const post = wiring.hooks!.PostToolUse![0]!.hooks[0]!;
  const recordThenPeer: HookCallback = async (...args) => {
    const result = await post(...args);
    if (args[0].hook_event_name === "PostToolUse" && args[0].tool_name === toolName) lockHeldDuringWrite = lockState.pendingReleases.has(args[0].tool_use_id);
    if (args[0].hook_event_name === "PostToolUse" && args[0].tool_name === "Read") {
      reads++;
      if (reads === 2) rereadContent = (args[0].tool_response as { file?: { content?: string } }).file?.content;
      // A real other actor changes bytes, preserving mtime so a timestamp-only
      // upstream check is not mistaken for this first-party SHA-256 guard.
      if (reads === 1 && !refused) { writeFileSync(path, peer); if (!recovered) utimesSync(path, stamp.atime, stamp.mtime); }
    }
    return result;
  };
  const hooks = { ...wiring.hooks, PostToolUse: [{ ...wiring.hooks!.PostToolUse![0]!, hooks: [recordThenPeer] }],
    PreToolUse: wiring.hooks!.PreToolUse!.map(group => ({ ...group, hooks: group.hooks.map(hook => (async (...args) => {
      const result = await hook(...args);
      if ("hookSpecificOutput" in result && result.hookSpecificOutput?.hookEventName === "PreToolUse" && result.hookSpecificOutput.permissionDecision === "deny" && result.hookSpecificOutput.permissionDecisionReason?.includes("changed since you read it")) nativeDenial = true;
      if ("hookSpecificOutput" in result && result.hookSpecificOutput?.hookEventName === "PreToolUse" && result.hookSpecificOutput.permissionDecision === "deny" && result.hookSpecificOutput.permissionDecisionReason?.includes("Native file writes are unavailable")) authorityDenial = true;
      return result;
    }) as HookCallback) })) };
  const adapter = new StreamAdapter();
  try {
    for await (const message of query({ prompt: "Read the loom, then make the planned file change.", options: { ...turn.options, maxTurns: 4, model: "claude-sonnet-4-6", hooks,
      // A hostile settings grant must not override the hosted call-time denial.
      settings: refused ? { permissions: { allow: ["Write", "Edit", "NotebookEdit"] }, hooks: { PreToolUse: [{ matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'" }] }] } } : undefined,
    } }) as AsyncIterable<SDKMessage>) {
      if (message.type === "system" && message.subtype === "init") version = message.claude_code_version;
      frames.push(...adapter.adapt(message));
      if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) if (block.type === "tool_result") lock.releaseForTool(block.tool_use_id);
    }
    expect(roster).toBeDefined();
    registeredTools ??= roster;
    expect(roster, "REQUEST_VISIBLE_TOOL_DEFINITIONS_STABLE").toBe(registeredTools);
    expect(authorityDenial, "FIRST_PARTY_NATIVE_AUTHORITY_DENIAL").toBe(refused);
    expect(lockHeldDuringWrite, "REAL_NATIVE_WRITE_LOCK_HELD").toBe(recovered);
    expect(version, "ACTUAL_INSTALLED_CLAUDE_FILE_TOOL_IDENTITY").toBe(MEASURED_RUNTIME.claudeCode);
    expect(sent).toBe(reread ? 3 : 2); expect(reads).toBe(reread ? 2 : 1);
    const expected = recovered ? (toolName === "Write" ? "Athena charts.\n" : "Odysseus sleeps.\n") : refused ? before : peer;
    expect(cards, "REAL_HOSTED_NO_PERMISSION_CARDS").toBe(0);
    if (toolName === "NotebookEdit" && recovered) expect(JSON.parse(readFileSync(path, "utf8")).cells[0].source).toBe("Athena charts.");
    else expect(readFileSync(path, "utf8"), "CLAUDE_NATIVE_STALE_WRITE_EFFECT").toBe(expected);
    expect(nativeDenial, "FIRST_PARTY_NATIVE_SHA_DENIAL").toBe(!recovered && !refused);
    if (recovered && toolName !== "NotebookEdit") expect(rereadContent).toBe(peer);
    else if (reread) expect(rereadContent).toBeUndefined();
    expect(frames.find(frame => frame.type === "tool_result" && frame.toolUseId === "toolu_ithaca_write")).toMatchObject({ isError: !recovered });
  } finally { clearTimeout(timer); controller.abort(); server.stop(true); await turn.finishWorker(); startupView.cleanup(); lock.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
