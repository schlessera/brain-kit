/** Run through run.ts: the SDK, CLI and tool descendants share an offline netns. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../packages/ui-backend-claude/src/sdk-options.js";
import { createFixtureWorkerStartupView } from "../../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.js";

const scratch = process.argv[2]!;
const home = join(scratch, "home"), brainPath = join(scratch, "ithaca");
mkdirSync(home, { recursive: true });
mkdirSync(brainPath, { recursive: true });
writeFileSync(join(brainPath, "CLAUDE.md"), "Odysseus plans the voyage. Today is 2026-07-12.");
const requests: unknown[] = [], turns: unknown[] = [];
let firstSessionId: string | undefined;
let turnIndex = 0, sessionId: string | undefined, cliVersion: string | undefined;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/messages") return Response.json({});
  const body = await request.json() as Record<string, any>;
  const id = `msg_odysseus_${requests.length + 1}`;
  requests.push({ turn: turnIndex, path, responseId: id, model: body.model, stream: body.stream === true,
    bodyFields: Object.keys(body).sort(), toolNames: body.tools?.map((t: any) => t.name) ?? [],
    outputConfig: body.output_config ?? null,
    // Record only explicit provenance fields; neither tool count nor model identifies a helper.
    querySource: body.query_source ?? null, requestSource: body.request_source ?? null,
    provenanceHeaders: Object.fromEntries([...request.headers].filter(([key]) => /query.source|request.source/.test(key))),
  });
  const content = [{ type: "text", text: (body.output_config?.format || body.output_config?.type === "json_schema") ? '{"title":"Odysseus plans the voyage"}' : "Odysseus checks the mast." }];
  const usage = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const message = { id, type: "message", role: "assistant", model: body.model, content, stop_reason: "end_turn", stop_sequence: null, usage };
  if (!body.stream) return Response.json(message, { headers: { "request-id": id } });
  const events = [{ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content[0]!.text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "request-id": id } });
} });
try {
  for (turnIndex = 1; turnIndex <= 2; turnIndex++) {
    const controller = new AbortController();
    const view = createFixtureWorkerStartupView(brainPath, { omitGit: true });
    let titleUsage: unknown = { receipts: [], coverage: "unknown" };
    const turn = createClaudeSdkTurn({ backend: { brainPath }, req: {
      prompt: "Odysseus plans the voyage. Reply briefly.", sessionId, signal: controller.signal, workerStartupView: view,
      bridge: { emit() {}, activity(event) { if (event.kind === "claude_title_usage") { const { kind: _kind, ...evidence } = event; titleUsage = evidence; } }, checkpointPermission() {}, async requestPermission() { return { behavior: "deny" as const, message: "Offline probe" }; } },
    }, profile: { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [], buildEnv: () => ({
      HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: server.url.origin,
      ANTHROPIC_API_KEY: "offline-odysseus",
      ...(process.argv.includes("--operator-telemetry") ? { OTEL_LOGS_EXPORTER: "none" } : {}),
      ...(process.argv.includes("--disable-nonessential-traffic") ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}),
    }) }, abortController: controller, allowedTools: ["Read"], confirmPatterns: [],
      turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
    });
    const messages: unknown[] = [];
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      let succeeded = false;
      for await (const msg of query({ prompt: turn.prompt, options: turn.options })) {
        if (msg.type === "system" && msg.subtype === "init") cliVersion = msg.claude_code_version;
        const raw = msg as unknown as Record<string, any>;
        messages.push({ type: msg.type, subtype: raw.subtype ?? null, fields: Object.keys(raw).sort(),
          parentToolUseId: raw.parent_tool_use_id ?? null,
          ...(msg.type === "stream_event" ? { event: msg.event.type, response: msg.event.type === "message_start" ? {
            id: msg.event.message.id, model: msg.event.message.model, usage: msg.event.message.usage,
          } : null } : {}),
          ...(msg.type === "result" ? { usage: msg.usage, modelUsage: msg.modelUsage, totalCostUsd: msg.total_cost_usd } : {}),
        });
        if (msg.type === "result") {
          if (msg.subtype !== "success" || msg.is_error) throw new Error(`Unsuccessful runtime result: ${msg.subtype}`);
          sessionId = msg.session_id; succeeded = true;
        }
      }
      if (!succeeded || !sessionId) throw new Error("Missing successful result");
      if (!firstSessionId) firstSessionId = sessionId;

    } finally { clearTimeout(timer); await turn.finishWorker(); view.cleanup(); }
    turns.push({ turn: turnIndex, resumed: turnIndex > 1, sameSession: sessionId === firstSessionId,
      titleUsage, logsExporter: turn.options.env?.OTEL_LOGS_EXPORTER ?? null, titleOptionPresent: Object.hasOwn(turn.options, "title"), messages });
  }
  const transcriptTypes: Record<string, number> = {};
  for await (const file of new Bun.Glob("**/*.jsonl").scan({ cwd: home, absolute: true, dot: true })) {
    for (const line of readFileSync(file, "utf8").trim().split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.type) transcriptTypes[row.type] = (transcriptTypes[row.type] ?? 0) + 1;
    }
  }
  const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir);
  const sdkVersion = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version;
  writeFileSync(join(scratch, "report.json"), JSON.stringify({ sdkVersion, cliVersion,
    origin: "scripted loopback in offline namespace; not first-party/provider evidence",
    requests, turns, transcriptTypes,
    productionAccounting: "automatic production SDK options emit supported helper receipts after worker exit",
    nonessentialTrafficDisabled: process.argv.includes("--disable-nonessential-traffic"),
  }, null, 2) + "\n");
} finally { server.stop(true); }
