// Keyless installed-runtime measurement for #2025. Only a loopback Messages
// origin is contacted; isolated HOME/config and synthetic credentials prevent
// borrowing provider access. This measures CLI accounting, not provider bills.
// bun scripts/measure-claude-usage.ts [--out report.json]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CompletedResponseUsage } from "../packages/ui-backend-claude/src/usage.js";

export async function measureClaudeUsage() {
  const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src"));
  const { query } = await import(entry) as typeof import("@anthropic-ai/claude-agent-sdk");
  const requests: Array<{ turn: number; model: string; stream: boolean }> = [];
  let turn = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
    const body = await request.json() as { model: string; stream?: boolean };
    requests.push({ turn, model: body.model, stream: body.stream === true });
    const message = { id: `msg_probe_${requests.length}`, type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    if (!body.stream) return Response.json(message);
    const events = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  } });
  const cwd = mkdtempSync(join(tmpdir(), "claude-usage-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "claude-usage-home-"));
  let sessionId: string | undefined, cliVersion: string | undefined;
  const turns: Array<{ turn: number; completed: ReturnType<CompletedResponseUsage["snapshot"]>; result: unknown }> = [];
  try {
    for (turn = 1; turn <= 2; turn++) {
      const completed = new CompletedResponseUsage();
      const q = query({ prompt: "Reply ok.", options: { cwd, model: "claude-sonnet-4-6", includePartialMessages: true,
        settingSources: [], ...(sessionId ? { resume: sessionId } : {}), env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}`, ANTHROPIC_API_KEY: "sk-ant-api03-probe-only",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        } } });
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") cliVersion = msg.claude_code_version;
        if (msg.type === "stream_event") completed.observe(msg.event, msg.parent_tool_use_id ?? "root");
        if (msg.type === "result") {
          if (msg.subtype !== "success" || msg.is_error) throw new Error(`Probe turn ${turn} did not succeed: ${msg.subtype}`);
          sessionId = msg.session_id;
          turns.push({ turn, completed: completed.snapshot(), result: {
            total_cost_usd: msg.total_cost_usd, usage: msg.usage, modelUsage: msg.modelUsage,
          } });
        }
      }
    }
    if (turns.length !== 2 || !cliVersion || turns.some(row => !row.completed)) throw new Error("Incomplete runtime measurement");
    return { date: new Date().toISOString(), sdk: JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version,
      cli: cliVersion, origin: "scripted loopback; no provider billing/cache claim", requests, turns };
  } finally { model.stop(true); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const report = JSON.stringify(await measureClaudeUsage(), null, 2);
  const out = process.argv.indexOf("--out");
  if (out >= 0) writeFileSync(process.argv[out + 1]!, `${report}\n`);
  console.log(report);
}
