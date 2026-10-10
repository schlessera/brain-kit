/** Actual ordinary adapter and server bridge behind kernel loopback isolation. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createClaudeBackend } from "../../packages/ui-backend-claude/src/backend.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { createActivityStore } from "../../packages/ui-server/src/activity/store.js";
import { createActivityStream } from "../../packages/ui-server/src/activity/stream.js";
import { createStaticBackendRegistry } from "../../packages/ui-server/src/agent/backend.js";
import { createSessionCatalog } from "../../packages/ui-server/src/ws/session-catalog.js";
import { WsHost } from "../../packages/ui-server/src/ws/host.js";
import { runSession } from "../../packages/ui-server/src/ws/run-session.js";
import type { InferenceProfile } from "../../packages/ui-backend-claude/src/profiles.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import * as core from "@schlessera/brain/internal";

const [scenario, root] = process.argv.slice(2) as [string, string];
const brainPath = join(root, "brain"), config = join(root, "claude");
cpSync(resolve("packages/core/fixtures/corpus"), brainPath, { recursive: true }); mkdirSync(config);
process.env.CLAUDE_CONFIG_DIR = config;
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
const configPath = join(brainPath, "brain.config.ts");
writeFileSync(configPath, readFileSync(configPath, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
const context = await core.initContext({ root: brainPath });
const index = core.openDatabase(context.dbPath);
await core.indexAll(index, { root: brainPath, taxonomy: context.taxonomy, force: true, quiet: true }); index.close();
const policyPath = join(brainPath, "context/policies/crew.md");
mkdirSync(join(brainPath, "context/policies"), { recursive: true });
const policy = "Athena: agent writers never change these policy bytes.\n";
writeFileSync(policyPath, policy);
writeFileSync(join(brainPath, "context/policies/crew.ipynb"), JSON.stringify({ cells: [{ cell_type: "markdown", id: "crew", source: [policy], metadata: {} }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
writeFileSync(join(brainPath, "indirect-write.sh"), `printf 'untrusted policy' > '${policyPath}'\nprintf 'untrusted entry' > '${join(brainPath, "context/policies/new.md")}'\nprintf 'Odysseus scratch succeeds' > "$BRAIN_WORKER_SCRATCH/raft.txt"\ncat "$BRAIN_WORKER_SCRATCH/raft.txt"\n`);
writeFileSync(join(brainPath, "brain-cli.sh"), `"${process.execPath}" "${resolve("packages/core/src/cli/brain.ts")}" add 'Untrusted capture' --json\n"${process.execPath}" "${resolve("packages/core/src/cli/brain.ts")}" search 'Odysseus' --json\n`);
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
mkdirSync(join(brainPath, "assets"), { recursive: true }); writeFileSync(join(brainPath, "assets/raft.png"), png);
// A project stdio server witnesses its namespace independently of the CLI.
writeFileSync(join(brainPath, "mcp-witness.ts"), `import {readlinkSync,writeFileSync} from 'node:fs';writeFileSync(process.env.BRAIN_WORKER_SCRATCH+'/mcp-namespace',readlinkSync('/proc/self/ns/pid'));process.execve(${JSON.stringify(process.execPath)},[${JSON.stringify(process.execPath)},${JSON.stringify(resolve("packages/core/src/cli/brain.ts"))},'mcp'],process.env);`);
writeFileSync(join(brainPath, ".mcp.json"), JSON.stringify({ mcpServers: { brain: { command: process.execPath, args: [join(brainPath, "mcp-witness.ts")] } } }));
const nativeBun = process.execPath;
const childMarker = `brain-claude-worker-${basename(root)}`;
const actions = scenario === "abort" ? [{ name: "Bash", input: { command: `"${nativeBun}" -e 'import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const c=spawn("sleep",["120"],{detached:true,stdio:"ignore",argv0:${JSON.stringify(childMarker)}});writeFileSync(process.env.BRAIN_WORKER_SCRATCH+"/child-pid",String(c.pid));await Bun.sleep(120000)'`, timeout: 120000 } }] : [
  { name: "Write", input: { file_path: policyPath, content: "Write changed policy" } },
  { name: "Edit", input: { file_path: policyPath, old_string: "Athena", new_string: "Untrusted" } },
  { name: "NotebookEdit", input: { notebook_path: join(brainPath, "context/policies/crew.ipynb"), cell_id: "crew", new_source: "Untrusted notebook", cell_type: "markdown", edit_mode: "replace" } },
  { name: "Bash", input: { command: "bash ./indirect-write.sh" } },
  { name: "mcp__brain-ui__write_file", input: { path: "notes/worker-raft.md", expectedBaseHash: null,
    content: "---\ntitle: Worker raft\ntype: note\nstatus: active\n---\nOdysseus sails through the validated worker route.\n" } },
  { name: "Bash", input: { command: "bash ./brain-cli.sh" } },
  { name: "mcp__brain__brain_search", input: { query: "Odysseus" } },
  { name: "Bash", input: { command: "cat \"$BRAIN_WORKER_SCRATCH/mcp-namespace\"; readlink /proc/self/ns/pid" } },
  { name: "mcp__brain-ui__request_image_mask", input: { imagePath: "assets/raft.png" } },
];
let step = 0, calls = 0; const requests: unknown[] = []; let host: WsHost;
const frames: ServerMessage[] = [];
let sawDetachedChild = false;
let abortTimer: ReturnType<typeof setTimeout> | undefined;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
  const body = await request.json(); requests.push({ tools: body.tools?.map((t: any) => t.name), results: body.messages?.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_result") : []) }); calls++;
  const action = actions[step++];
  if (scenario === "abort" && action) {
    const deadline = Date.now() + 5000;
    const check = () => {
      sawDetachedChild = readdirSync("/proc").some(pid => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] === childMarker; } catch { return false; } });
      if (sawDetachedChild || Date.now() > deadline) { for (const turn of host.coordinator.running) turn.abortController.abort(); }
      else abortTimer = setTimeout(check, 20);
    };
    abortTimer = setTimeout(check, 20);
  }
  const events: unknown[] = [{ type: "message_start", message: { id: `msg_${calls}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
  if (action) events.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${calls}`, name: action.name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(action.input) } });
  else events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus completes the worker turn." } });
  events.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: action ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return new Response(events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
const db = createUiDb(":memory:"); const store = createActivityStore(db, { writer: "claude-worker-test" }), stream = createActivityStream(store);
const profile: InferenceProfile = { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [], buildEnv: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "offline-fixture", CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }) };
const backend = createClaudeBackend({ brainPath, profiles: [profile], log: () => {} });
host = new WsHost({ brainPath, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => db), isPrincipalAuthorized: () => true, activity: { store, stream }, turnTimeoutMs: 25000 });
// Simulate only the browser mask response, preserving the actual server bridge.
host.clients.add({ send(text: string) {
  const frame = JSON.parse(text); frames.push(frame);
  if (frame.type === "mask_request") {
    const pending = host.coordinator.pendingMask.get(frame.requestId)!;
    host.coordinator.pendingMask.delete(frame.requestId); pending.resolve(png);
  }
  if (frame.type === "tool_approval_request") {
    const pending = host.coordinator.pendingApprovals.get(frame.toolUseId)!;
    host.coordinator.pendingApprovals.delete(frame.toolUseId); pending.resolve({ behavior: "allow" });
  }
} }, "odysseus");
try {
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  await runSession(host, { authorization, text: "Odysseus worker fixture", attachments: [], providerId: "fixture" }); authorization.release();
  const sessionId = frames.find(frame => frame.type === "session_info")?.sessionId;
  if (scenario !== "abort" && sessionId) {
    const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
    await runSession(host, { authorization, sessionId, text: "Resume the Odysseus worker fixture", attachments: [], providerId: "fixture" }); authorization.release();
  }
  const sessions = await backend.listSessions(); const histories = await Promise.all(sessions.map(s => backend.getHistory(s.id)));
  const appEvents = db.query("SELECT event_type, payload FROM activity_events WHERE event_type LIKE 'brain_application%'").all();
  const index = core.openDatabase(context.dbPath); const indexed = index.query("SELECT path FROM documents WHERE path = 'notes/worker-raft.md'").all(); index.close();
  console.log(JSON.stringify({ calls, sawDetachedChild, childMarker, requests, frames, appEvents, sessions, histories, indexed,
    policy: readFileSync(policyPath, "utf8"), entries: readdirSync(join(brainPath, "context/policies")).sort(),
    notebook: readFileSync(join(brainPath, "context/policies/crew.ipynb"), "utf8"),
    ordinary: existsSync(join(brainPath, "notes/worker-raft.md")) ? readFileSync(join(brainPath, "notes/worker-raft.md"), "utf8") : null,
    mask: existsSync(join(brainPath, "assets/raft-mask.png")) ? [...readFileSync(join(brainPath, "assets/raft-mask.png"))] : null }));
} finally { clearTimeout(abortTimer); host.close(); stream.close(); db.close(); server.stop(true); }
