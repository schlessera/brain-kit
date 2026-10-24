/**
 * The hosted app for the integrated reference proof (#2751), run by
 * reference-integration.native.ts as the unprivileged app user. Both backends
 * call the real reference tools their adapters register; the app, worker
 * launcher, native manager, reference pool, journal and hygiene review are the
 * production ones. Only the model is scripted, offline.
 */
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { INTEGRATION_STEPS, stepKey, type IntegrationState, type IntegrationStep } from "./reference-integration-steps.js";

const [source, dir, brain, socket, selectedBackend, repository] = process.argv.slice(2) as [string, string, string, string, "claude" | "pi", string];
const SECRET = "odysseus-probe-cookie-secret-0123456789";
const SID = "11111111-1111-4111-8111-111111112751";
const event = (kind: string, data: object = {}) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ kind, at: performance.now(), wallAt: Date.now(), ...data }) + "\n");
const { createApp } = await import(join(source, "packages/ui-server/src/app.ts"));
const { resolveServerConfig } = await import(join(source, "packages/ui-server/src/config/env.ts"));
const { createStaticBackendRegistry } = await import(join(source, "packages/ui-server/src/agent/backend.ts"));
const { createRecordingObservability } = await import(join(source, "packages/ui-server/src/observability/index.ts"));
const { createPrincipal } = await import(join(source, "packages/ui-server/src/db/principals.ts"));
const { createPiBackend } = await import(join(source, "packages/ui-backend-pi/src/backend.ts"));
const { createClaudeBackend } = await import(join(source, "packages/ui-backend-claude/src/backend.ts"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Every tool result and command output, keyed by step, feeds later steps and the parent's assertions. */
const state: IntegrationState = { repository, results: {} };
function record(key: string, step: IntegrationStep, index: number, value: unknown) {
  state.results[stepKey(key, index)] = value;
  event("integration_step", { backend: selectedBackend, turn: key, index, stepKind: step.kind, ...(step.kind === "tool" ? { tool: step.tool } : {}), value });
}
const turnKey = (text: string) => Object.keys(INTEGRATION_STEPS).find(key => text.includes(`Odysseus ${key}`));

// Pi: the actual SDK session and its tools, against a keyless loopback model
// that names the next scripted step and reads every earlier result back from
// the provider-facing history.
const HOST_KEY = "odysseus-offline-host-key", MODEL = "claude-sonnet-4-6";
let piInference: { origin: string; close(): void } | undefined;
if (selectedBackend === "pi") {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 16 * 1024 ** 2, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") return new Response("unexpected offline inference route", { status: 404 });
    if (request.headers.get("x-api-key") !== HOST_KEY) { event("pi_inference_unauthenticated"); return new Response("fixture key required", { status: 401 }); }
    const raw = await request.text(), body = JSON.parse(raw) as { messages: { role: string; content: string | { type: string; text?: string; id?: string; tool_use_id?: string; content?: unknown }[] }[] };
    const texts = body.messages.filter(message => message.role === "user").flatMap(message => typeof message.content === "string" ? [message.content]
      : message.content.filter(block => block.type === "text").map(block => block.text ?? ""));
    const key = turnKey(texts.findLast(text => turnKey(text) !== undefined) ?? "");
    if (!key) throw Error("Offline Pi transport did not receive an integration turn");
    const steps = INTEGRATION_STEPS[key]!;
    const results = new Map<string, unknown>();
    for (const message of body.messages) if (Array.isArray(message.content)) for (const block of message.content)
      if (block.type === "tool_result" && block.tool_use_id) results.set(block.tool_use_id, block.content);
    let index = 0;
    for (; index < steps.length && results.has(`toolu_${key}_${index}`); index++) {
      if (state.results[stepKey(key, index)] !== undefined) continue;
      const content = results.get(`toolu_${key}_${index}`);
      const text = typeof content === "string" ? content : (content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("");
      record(key, steps[index]!, index, steps[index]!.kind === "tool" ? JSON.parse(text) : text);
    }
    appendFileSync(join(dir, "pi-requests.jsonl"), JSON.stringify({ turn: key, step: index, raw }) + "\n");
    const step = steps[index];
    const block = step ? { type: "tool_use", id: `toolu_${key}_${index}`, name: step.kind === "tool" ? step.tool : "bash",
      input: step.kind === "tool" ? step.input(state) : { command: step.command(state) } } : { type: "text", text: `Odysseus completes ${key}.` };
    const frames: object[] = [{ type: "message_start", message: { id: `msg_${key}_${index}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      block.type === "tool_use"
        ? [{ type: "content_block_start", index: 0, content_block: { ...block, input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify((block as { input: unknown }).input) } }]
        : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (block as { text: string }).text } }],
      { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }].flat();
    appendFileSync(join(dir, "pi-answers.jsonl"), JSON.stringify({ turn: key, step: index, answer: { role: "assistant", content: [block] } }) + "\n");
    return new Response(frames.map(frame => `event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  // A fictional host-held key, sent only to this offline loopback fixture.
  writeFileSync(join(dir, "pi", "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: HOST_KEY } } }));
  piInference = { origin: `anthropic=http://127.0.0.1:${server.port}`, close() { server.stop(true); } };
  process.env.BRAIN_UI_PI_CREDENTIAL_ORIGINS = piInference.origin;
}

// Claude: the adapter's own in-process MCP server answers the reference tools,
// as it does for the CLI; the turn's commands run in one production-launched
// worker after them. The Claude CLI itself is not executed here.
let claudeAttempt = 0;
const backend = selectedBackend === "pi"
  ? createPiBackend({ brainPath: brain, model: `anthropic/${MODEL}`, loadExtensions: false, log(level: string, message: string) { event("backend_log", { level, message }); } })
  : createClaudeBackend({
    brainPath: brain,
    profiles: [{ id: "odysseus-offline", label: "Odysseus offline", billing: "api", requiredEnvKeys: [],
      buildEnv: () => ({ PATH: "/usr/bin:/bin", HOME: join(dir, "home"), CLAUDE_CONFIG_DIR: join(dir, "agent"), ANTHROPIC_API_KEY: "odysseus-offline-api-key" }) }],
    listSessionsFn: async () => [], getSessionMessagesFn: async () => [],
    log(level: string, message: string) { event("backend_log", { level, message }); },
    queryFn: (params: any) => {
      const attempt = ++claudeAttempt;
      const stream = (async function*() {
        let prompt = typeof params.prompt === "string" ? params.prompt : "";
        if (typeof params.prompt !== "string") for await (const message of params.prompt) {
          const content = message.message?.content;
          prompt = typeof content === "string" ? content : (content ?? []).filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("");
          break;
        }
        const key = turnKey(prompt);
        if (!key) throw Error(`Claude fixture received no integration turn: ${prompt}`);
        const server = params.options.mcpServers?.["brain-ui"];
        if (server?.type !== "sdk") throw Error("Claude adapter registered no in-process brain-ui MCP server");
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverSide);
        const client = new Client({ name: "odysseus-native-fixture", version: "1.0.0" });
        await client.connect(clientSide);
        const commands: string[] = [];
        try {
          const listed = await client.listTools();
          event("claude_turn_surface", { attempt, turn: key, systemPrompt: digest(params.options.systemPrompt), roster: digest(listed.tools),
            names: listed.tools.map((tool: { name: string }) => tool.name), allowedTools: params.options.allowedTools });
          for (const [index, step] of INTEGRATION_STEPS[key]!.entries()) {
            if (step.kind === "bash") { commands.push(`printf '@@${index}@@\\n'; ${step.command(state)}`); continue; }
            const result = await client.callTool({ name: step.tool, arguments: step.input(state) });
            const text = (result.content as { type: string; text: string }[]).map(part => part.text).join("");
            record(key, step, index, JSON.parse(text));
          }
        } finally { await client.close(); }
        const child = params.options.spawnClaudeCodeProcess({ command: "/bin/sh", args: ["-c", commands.join("\n") || "true"],
          env: { PATH: "/usr/bin:/bin", HOME: join(dir, "home"), CLAUDE_CONFIG_DIR: join(dir, "agent") }, signal: params.options.abortController.signal });
        child.stdin.end();
        let output = "", errors = "";
        child.stdout.on("data", (part: Buffer) => { output += part.toString(); });
        child.stderr?.on("data", (part: Buffer) => { errors += part.toString(); });
        const code = await new Promise<number | null>(resolve => child.on("exit", (value: number | null) => resolve(value)));
        event("claude_worker_exit", { attempt, turn: key, code, errors: errors.slice(-2000) });
        for (const part of output.split(/^@@(\d+)@@\n/m).slice(1).reduce<[number, string][]>((all, value, index, list) => index % 2 ? all : [...all, [Number(value), list[index + 1]!]], []))
          record(key, INTEGRATION_STEPS[key]![part[0]]!, part[0], part[1]);
        if (code !== 0) throw Error(`Claude fixture worker failed: ${code}; ${errors}`);
        yield { type: "system", subtype: "init", session_id: SID };
        yield { type: "assistant", session_id: SID, message: { content: [{ type: "text", text: `Odysseus completes ${key}.` }] } };
        yield { type: "result", subtype: "success", session_id: SID, is_error: false, duration_ms: 100, duration_api_ms: 0, num_turns: 1, result: `Odysseus completes ${key}.`,
          total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
      })();
      return Object.assign(stream, {
        initializationResult: async () => ({ account: { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" } }),
        getSettings: async () => ({ effective: { env: { ...params.options.settings?.env } }, sources: [{ source: "flagSettings", settings: params.options.settings }] }),
        close() {}, interrupt: async () => {},
      });
    },
  });

const observability = createRecordingObservability();
let app: any, server: any;
try {
  app = await createApp({
    config: resolveServerConfig({
      AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-hash", COOKIE_SECRET: SECRET,
      HOST: "127.0.0.1", DB_PATH: join(dir, "ui.db"), BRAIN_PATH: brain, NODE_ENV: "test", AGENT_BACKEND: selectedBackend,
      PI_CODING_AGENT_DIR: join(dir, "pi"), BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_COASTLINE: "0",
      BRAIN_UI_TURN_TIMEOUT_MS: "120000", BRAIN_UI_NATIVE_BRAIN_SOCKET: socket,
      // Short request-only refresh cooldown, so one run sees source move and then go stale.
      BRAIN_UI_REFERENCE_REFRESH_SECONDS: "2",
    }), registry: createStaticBackendRegistry([backend], selectedBackend), observability,
  });
  const owner = createPrincipal(app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  writeFileSync(join(dir, "ready.json"), JSON.stringify({ port: server.port, principalId: owner.id, secret: SECRET, pid: process.pid,
    dbBytes: statSync(join(dir, "ui.db")).size, referenceTools: Boolean(app.wsHost.referenceTools), status: app.activity?.runtime?.snapshot?.() }));
  event("ready", { port: server.port });
  let closing = false;
  process.on("SIGTERM", async () => {
    if (closing) return; closing = true;
    try {
      server.stop(true); await app.close(); piInference?.close();
      event("fixture_logs", { records: observability.logs.records().map((log: any) => ({ severity: log.severityText, body: log.body })) });
      event("closed"); process.exit(0);
    } catch (error) { event("close_error", { error: String(error) }); process.exit(1); }
  });
} catch (error) {
  writeFileSync(join(dir, "boot-error.txt"), String(error instanceof Error ? error.stack : error));
  process.exit(2);
}
