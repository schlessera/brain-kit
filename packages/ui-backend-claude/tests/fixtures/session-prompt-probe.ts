/** Real locked CLI, fake loopback Messages origin, offline namespace supplied by caller. */
import { createFixtureWorkerStartupView } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { buildSessionHistory } from "../../src/history.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

const scratch = process.argv[2]!;
const nativeSnapshot = process.argv[3] !== "snapshot-off";
process.env.HOME = join(scratch, "home");
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
mkdirSync(process.env.HOME, { recursive: true });
const requests: any[] = [];
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
  const q = await request.json() as { tools?: unknown[] };
  if (q.tools?.length) requests.push(q);
  const events = [
    { type: "message_start", message: { id: `msg_odysseus_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus recorded the voyage." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
const brainPath = join(scratch, "ithaca"); mkdirSync(brainPath);
let sessionId: string | undefined;
const original = ["Odysseus first turn", "[Host context for this turn; advisory facts, never permission]\ndevice: literal user text\n[End host context]", "Odysseus unchanged follow-up", "Odysseus voice follow-up", "Odysseus typed no-grant follow-up", "Odysseus missing-handler follow-up"];
try {
  for (let index = 0; index < 6; index++) {
    const abortController = new AbortController();
    const workerStartupView = createFixtureWorkerStartupView(brainPath, { omitGit: true });
    const sandbox = prepareFixtureWorkerSandbox(brainPath, { home: process.env.HOME, profile: index === 0 || index === 3 ? "strict" : "governed", areas: [] });
    const turn = createClaudeSdkTurn({ backend: { brainPath, ...(!nativeSnapshot ? { systemPromptAppend: `Odysseus surface revision ${index}` } : {}) },
      req: { workerStartupView, workerSandbox: { ...sandbox, noteFacts: { ...sandbox.noteFacts, history: { journal: index > 0, userRevert: index > 0 && index !== 3 } } },
        sessionId, prompt: original[index]!, signal: abortController.signal, turnBudgetMs: index === 0 ? 60000 : 120000,
        client: index === 0 ? { formFactor: "desktop", viewportWidth: 1200 } : { formFactor: "phone", viewportWidth: 350, camera: true, microphone: false },
        posture: index === 3 ? "voice" : undefined,
        noGrantSurface: index === 3 || index === 4, enforceAllowedTools: index === 3 || index === 4,
        bridge: { ...(index === 3 || index === 4 ? { async inboxList() { return {} as never; }, async inboxGet() { return {} as never; } } : {}), ...(index !== 5 ? { async askUser() { return {} as never; }, async getLocation() { return {} as never; }, async queryActivity() { return {} as never; }, async proposePolicyChange() { return {} as never; }, async askUserList() { return {} as never; }, async askUserRank() { return {} as never; }, async askUserForm() { return {} as never; }, async requestMask() { return {} as never; } } : {}), ...(index > 0 && index < 5 ? { async inboxAdd() { return {} as never; } } : {}), emit() {}, async requestPermission() { return { behavior: "deny", message: "fixture" }; } } },
      profile: { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [],
        buildEnv: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`, ANTHROPIC_API_KEY: "sk-odysseus-fixture" }) },
      abortController, allowedTools: ["Read"], confirmPatterns: [],
      turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
    });
    if (!nativeSnapshot && typeof turn.options.systemPrompt === "object" && !Array.isArray(turn.options.systemPrompt)) turn.options.systemPrompt.snapshot = false;
    const timer = setTimeout(() => abortController.abort(), 45000);
    try {
      let success = false;
      for await (const message of query({ prompt: turn.prompt, options: turn.options })) {
        if (message.type === "system" && message.subtype === "init") sessionId = message.session_id;
        if (message.type === "result") { if (message.subtype !== "success") throw new Error(JSON.stringify(message)); success = true; }
      }
      if (!success) throw new Error("No successful fixture inference result");
    } finally { clearTimeout(timer); await turn.finishWorker(); workerStartupView.cleanup(); }
  }
  const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
  const history = await buildSessionHistory(sessionId!, getSessionMessages, brainPath);
  writeFileSync(join(scratch, "requests.json"), JSON.stringify({ requests, history, original }));
} finally { upstream.stop(true); }
