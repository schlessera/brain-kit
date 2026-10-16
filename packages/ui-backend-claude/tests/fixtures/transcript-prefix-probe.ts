/** Narrow #2049 proof; follows the offline CLI pattern from #2053/#2047. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { createHistory } from "../../src/history.js";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../../ui-server/tests/helpers/fixture-native-startup.js";
const restore = replaceNativeStartupAcquisitionForFixture();
const scratch = process.argv[2]!;
const cacheEnabled = process.argv[3] === "cache-on";
process.env.HOME = join(scratch, "home"); process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
mkdirSync(process.env.HOME, { recursive: true });
const brain = join(scratch, "ithaca");
cpSync(resolve("packages/core/fixtures/corpus"), brain, { recursive: true });
const config = join(brain, "brain.config.ts");
writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
writeFileSync(join(brain, ".gitignore"), ".brain/\n");
mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
mkdirSync(join(brain, "docs"), { recursive: true });
writeFileSync(join(brain, "docs/ithaca-chart.md"), "Odysseus verifies the Ithaca chart.\n");
// Disable runtime cache-breakpoint annotations in this byte comparison only;
// moving cache_control markers are transport metadata, not transcript content.
const requests: any[] = [];
let step = 0;
const link = "[Ithaca chart](/tmp/ithaca-chart.pdf)";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
  const body = await request.json() as any;
  if (!body.tools?.some((tool: any) => tool.name === "Read")) return Response.json({});
  requests.push(body);
  const index = step++;
  const content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, string> }> = index === 0
    ? [{ type: "tool_use", id: "toolu_chart", name: "Bash", input: { command: "printf 'Odysseus charts Ithaca.' > /tmp/ithaca-chart.pdf" } }]
    : index === 1 ? [{ type: "text", text: `Before checking: ${link}` }, { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: join(brain, "docs/ithaca-chart.md") } }]
      : [{ type: "text", text: index === 2 ? `After checking: ${link}` : "Odysseus follows the chart." }];
  const events: any[] = [{ type: "message_start", message: { id: `msg_odysseus_${index}`, type: "message", role: "assistant", model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }];
  content.forEach((block, i) => events.push({ type: "content_block_start", index: i, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: i, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
    { type: "content_block_stop", index: i }));
  events.push({ type: "message_delta", delta: { stop_reason: index < 2 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
let sessionId: string | undefined;
try {
  for (let turnIndex = 0; turnIndex < 2; turnIndex++) {
    const controller = new AbortController(), view = createFixtureWorkerStartupView(brain);
    const sandbox = prepareFixtureWorkerSandbox(brain, { home: process.env.HOME, profile: "strict" });
    const turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: { prompt: turnIndex ? "Use the chart" : "Prepare the chart", sessionId,
      signal: controller.signal, turnId: `odysseus-${turnIndex}`, workerStartupView: view, workerSandbox: sandbox,
      bridge: { emit() {}, async requestPermission() { return { behavior: "allow" }; } } },
      profile: { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [], buildEnv: () => ({
        ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "offline-odysseus", ...(!cacheEnabled ? { DISABLE_PROMPT_CACHING: "1" } : {}), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }) },
      abortController: controller, allowedTools: ["Read", "Bash"], confirmPatterns: [], turnLock: { acquire() {}, release() {} } as never, log() {} });
    const deadline = setTimeout(() => controller.abort(), 45000);
    try {
      let success = false;
      for await (const message of query({ prompt: turn.prompt, options: turn.options })) {
        if (message.type === "assistant") for (const block of message.message.content) if (block.type === "text") turn.observeAnswerText(block.text);
        if (message.type === "result") { if (message.subtype !== "success") throw new Error(JSON.stringify(message)); sessionId = message.session_id; success = true; }
      }
      if (!success) throw new Error("No successful runtime result");
    } finally { clearTimeout(deadline); await turn.finishWorker(); await view.cleanup(); }
  }
  const history = await createHistory({ brainPath: brain, getSessionMessagesFn: getSessionMessages }).getHistory(sessionId!);
  const transcript = readFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects", brain.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`), "utf8");
  writeFileSync(join(scratch, "requests.json"), JSON.stringify({ requests, history, transcript }));
} finally { restore(); server.stop(true); }
