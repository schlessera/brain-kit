/** Real installed CLI, fictional credentials and a loopback-only namespace. */
import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createPermissionWiring } from "../../src/permission-hooks";
import { createTurnLockBinding } from "../../src/turn-lock";
import { createHistory } from "../../src/history";
import { transcriptPaths } from "../../src/transcript-archive";
function reply(call?: { name: string; input: Record<string, unknown>; id: string }): Response {
  const events: unknown[] = [{ type: "message_start", message: { id: "msg_ithaca", type: "message", role: "assistant", model: "claude-probe", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: call.id, name: call.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  return new Response(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

const root = process.argv[2]!;
for (const enforced of [false, true]) {
  const brain = join(root, enforced ? "enforced" : "ordinary"), home = brain + "-home";
  mkdirSync(brain); mkdirSync(home);
  const marker = join(brain, "shell-executed"), foreground = join(brain, "foreground-executed");
  let sent = 0, permissionRequests = 0;
  const calls = [{ name: "Bash", id: "toolu_background", input: { command: `echo Ithaca > '${marker}'`, run_in_background: true } },
    { name: "Bash", id: "toolu_foreground", input: { command: `echo Ithaca > '${foreground}'`, run_in_background: false } }];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
    await request.json(); return reply(calls[sent++]);
  } });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
  const lock = createTurnLockBinding({ turn: { ended: false, pendingReleases: new Map() }, writeLock: createKeyedLock(), lockWaitMs: 1000, log: () => {} });
  const allowedTools = enforced ? [] : ["Bash"];
  const wiring = createPermissionWiring({ req: { prompt: "Return to Ithaca.", signal: controller.signal, enforceAllowedTools: enforced,
    bridge: { emit: () => {}, requestPermission: async () => { permissionRequests++; return { behavior: "deny", message: "Not approved." }; } } },
    allowedTools, confirmPatterns: [], brainPath: brain, turnLock: lock, childEnv: { PATH: "/usr/bin:/bin" }, log: () => {} });
  const results: Record<string, unknown> = {};
  try {
    for await (const message of query({ prompt: "Use the two shell calls.", options: { cwd: brain, settingSources: [], model: "claude-sonnet-4-6", permissionMode: "default", allowedTools, ...wiring,
      maxTurns: 4, abortController: controller, env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: process.env.PATH!,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "odysseus-offline-only-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } } })) {
      if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) if (block.type === "tool_result") { results[block.tool_use_id] = block; lock.releaseForTool(block.tool_use_id); }
      if (message.type === "result") break;
    }
    expect(sent).toBe(3);
    expect(existsSync(marker), "NATIVE_BACKGROUND_BASH_MUST_NOT_EXECUTE").toBe(false);
    expect(results.toolu_background).toMatchObject({ is_error: true });
    expect(JSON.stringify(results.toolu_background)).toContain("run_in_background: false");
    expect(existsSync(foreground), "FOREGROUND_ALLOWLIST_PARITY").toBe(!enforced);
    expect(permissionRequests).toBe(enforced ? 1 : 0);
  } finally { clearTimeout(timer); controller.abort(); server.stop(true); lock.close(); }
}

// Produce a real orphaned task transcript by ending SDK iteration at its turn
// result, as the host does. No guard in this setup: legacy replay needs a
// positive control containing actual runtime-authored notification provenance.
{
  const brain = join(root, "legacy"), home = join(root, "legacy-home"); mkdirSync(brain); mkdirSync(home);
  let sent = 0, session = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
    await request.json(); return reply(sent++ === 0 ? { name: "Bash", id: "toolu_legacy", input: { command: "sleep 30", run_in_background: true } } : undefined);
  } });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: process.env.PATH!, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "odysseus-offline-only-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  try {
    for (const resume of [false, true]) for await (const message of query({ prompt: resume ? "Keep Penelope's words." : "Return to Ithaca.", options: {
      cwd: brain, settingSources: [], model: "claude-sonnet-4-6", permissionMode: "default", allowedTools: ["Bash"], env, abortController: controller, maxTurns: 3, ...(resume ? { resume: session } : {}) } })) {
      if (message.type === "system" && message.subtype === "init") session = message.session_id;
      if (message.type === "result") break;
    }
    const { live } = transcriptPaths(brain, env);
    const path = join(live, `${session}.jsonl`), raw = readFileSync(path, "utf8");
    const notice = raw.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.type === "user" && entry.origin?.kind === "task-notification");
    expect(notice, "REAL_RUNTIME_ORPHAN_NOTICE_PROVENANCE").toBeDefined();
    expect(JSON.stringify(notice.message.content)).toContain("didn't finish before the previous session ended");
    // The SDK's filesystem reader follows CLAUDE_CONFIG_DIR. Keep the actual
    // transcript/chain and its own message selection rather than replacing it.
    const prior = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    try {
      const history = await createHistory({ brainPath: brain, env }).getHistory(session);
      expect(history.filter(message => message.role === "user").map(message => message.content), "NATIVE_NOTIFICATION_REPLAY_KEEPS_EXACT_USER_TEXT").toEqual(["Return to Ithaca.", "Keep Penelope's words."]);
    } finally { if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior; }
  } finally { clearTimeout(timer); controller.abort(); server.stop(true); }
}
console.log("NATIVE_BACKGROUND_AND_NOTIFICATION_PROOF_PASSED");
