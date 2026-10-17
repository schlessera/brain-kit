/** Native Pi workers and local OpenAI-compatible requests, confined by the caller. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPiBackend } from "../../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
const scratch = process.argv[2]!;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const brain = join(scratch, "ithaca"), sessionDir = join(scratch, "sessions");
cpSync(resolve("packages/core/fixtures/corpus"), brain, { recursive: true });
const config = join(brain, "brain.config.ts");
writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
writeFileSync(join(brain, ".gitignore"), ".brain/\n");
mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
mkdirSync(join(brain, "docs"), { recursive: true });
writeFileSync(join(brain, "docs/ithaca-chart.md"), "Odysseus verifies the Ithaca chart.\n");
const requests: any[] = [];
let step = 0;
const link = "[Ithaca chart](/tmp/ithaca-chart.pdf)";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== "/v1/chat/completions") throw new Error(`Unexpected endpoint ${request.url}`);
  const body = await request.json() as any; requests.push(body);
  const index = step++;
  const tool = index === 0 ? { id: "call_chart", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf 'Odysseus charts Ithaca.' > /tmp/ithaca-chart.pdf" }) } }
    : index === 1 ? { id: "call_read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "docs/ithaca-chart.md" }) } } : undefined;
  const text = index === 1 ? `Before checking: ${link}` : index === 2 ? `After checking: ${link}` : index > 2 ? "Odysseus follows the chart." : "";
  const chunks = [
    { id: `chat_odysseus_${index}`, object: "chat.completion.chunk", model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: text, ...(tool ? { tool_calls: [{ index: 0, ...tool }] } : {}) }, finish_reason: null }] },
    { id: `chat_odysseus_${index}`, object: "chat.completion.chunk", model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { openai: {
  baseUrl: `${server.url.origin}/v1`, api: "openai-completions", apiKey: "offline-odysseus", models: [{ id: "gpt-4o-mini" }],
} } }));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
let sessionId: string | undefined;
try {
  for (let index = 0; index < 2; index++) {
    const backend = createPiBackend({ brainPath: brain, sessionDir, loadExtensions: false, confirmBashPatterns: [],
      profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }] });
    const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "strict" });
    const frames: ServerMessage[] = [], controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 45000);
    try {
      await startFixtureTurn(backend, brain, { prompt: index ? "Use the chart" : "Prepare the chart", profileId: "fixture", sessionId,
        signal: controller.signal, turnId: `odysseus-${index}`, workerSandbox: sandbox,
        bridge: { emit(frame) { frames.push(frame); }, async requestPermission() { return { behavior: "allow" }; } } });
      const result = frames.findLast(frame => frame.type === "result");
      if (!result || result.outcome !== "success") throw new Error(JSON.stringify(frames));
      sessionId = result.sessionId;
    } finally { clearTimeout(deadline); }
  }
  const history = await createPiBackend({ brainPath: brain, sessionDir }).getHistory(sessionId!);
  const transcript = readFileSync(join(sessionDir, `${sessionId}.jsonl`), "utf8");
  writeFileSync(join(scratch, "requests.json"), JSON.stringify({ requests, history, transcript }));
} finally { server.stop(true); }
