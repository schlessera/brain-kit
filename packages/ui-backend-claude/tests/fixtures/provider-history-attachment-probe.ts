/**
 * Attachment reads through the installed Claude CLI (#3154). The caller
 * confines the SDK, the bundled CLI and every tool to loopback. Turn 0 sends
 * the host's real first message, references only; the model then calls
 * `mcp__brain-ui__read_attachment` through the CLI's MCP route, and the host
 * half is the production reader and PDF extractor over real stored originals.
 * Turn 1 reads the text original, and turn 2 rereads the PDF page. Tools,
 * system and earlier messages must stay byte-identical.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../../ui-server/tests/helpers/fixture-native-startup.js";
import { fixtureAttachmentHost } from "../../../ui-server/tests/fixtures/attachment-host-fixture.js";
import { fixtureBrain } from "../../../../tests/fixtures/provider-history-brain.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
import type { ReadAttachmentInput } from "@schlessera/brain-ui-sdk/tool-contracts";

const scratch = process.argv[2]!;
const captures: Captures = {};
const capture: HistoryCapture = captures.attachment = { sessions: [], exchanges: [], appends: [], calls: [], rosters: [] };
let turnIndex = 0;
let queue: Array<{ name: string; input: Record<string, unknown> }> = [];

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/messages") return Response.json({});
  const raw = await request.text(), body = JSON.parse(raw);
  const main = body.tools?.some((tool: any) => tool.name === "Read") === true;
  const step = main ? queue.shift() : undefined;
  const content = step ? [{ type: "tool_use", id: `toolu_odysseus_${turnIndex}_${capture.exchanges.length}`, name: `mcp__brain-ui__${step.name}`, input: step.input }]
    : [{ type: "text", text: main ? "Odysseus may berth at Ithaca." : JSON.stringify({ title: "Odysseus reads the permit" }) }];
  capture.exchanges.push({ turn: turnIndex, path, raw, main, answer: { role: "assistant", content } });
  const events: any[] = [{ type: "message_start", message: { id: `msg_odysseus_${capture.exchanges.length}`, type: "message", role: "assistant",
    model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }];
  const block = content[0]!;
  events.push({ type: "content_block_start", index: 0, content_block: step ? { ...block, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: "input" in block ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: (block as { text: string }).text } }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
const restore = replaceNativeStartupAcquisitionForFixture();
try {
  const brain = fixtureBrain(scratch, "attachment");
  const host = fixtureAttachmentHost(brain, scratch);
  const script = [[{ name: "read_attachment", input: { id: host.permit.fileId, pages: "2" } }],
    [{ name: "read_attachment", input: { id: host.log.fileId } }],
    [{ name: "read_attachment", input: { id: host.permit.fileId, pages: "2" } }]];
  const home = join(scratch, "home-attachment");
  mkdirSync(join(home, ".claude"), { recursive: true });
  let sessionId: string | undefined;
  try {
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      queue = [...script[turnIndex]!];
      const controller = new AbortController();
      const sandbox = prepareFixtureWorkerSandbox(brain, { home, profile: "strict", areas: [] });
      const view = createFixtureWorkerStartupView(brain);
      const turnId = `odysseus-attachment-${turnIndex}`;
      const budget = { used: 0 };
      const turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: {
        prompt: turnIndex === 0 ? host.prompt : `Odysseus reads on, step ${turnIndex}.`, sessionId, signal: controller.signal, turnId,
        workerStartupView: view, workerSandbox: sandbox, client: { formFactor: "tablet", viewportWidth: 800, camera: true }, turnBudgetMs: 60_000,
        bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "allow" as const }; },
          activity(event: { kind: string; prefix?: { tools: string | null } }) { if (event.kind === "prompt_prefix") capture.rosters!.push(event.prefix!.tools); },
          // The ws bridge's adapter: the context is this turn's, never the call's.
          async readAttachment(input: ReadAttachmentInput) {
            capture.calls!.push(input);
            return host.read(turnId, controller.signal, budget, input);
          } },
      }, profile: { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [], buildEnv: () => ({
        HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "offline-odysseus",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      }) }, abortController: controller, allowedTools: ["Read", "Bash"], confirmPatterns: [],
        turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
      });
      capture.appends.push(turn.options.systemPrompt);
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        let success = false;
        for await (const message of query({ prompt: turn.prompt, options: turn.options })) {
          if (message.type === "assistant") for (const block of message.message.content) if (block.type === "text") turn.observeAnswerText(block.text);
          if (message.type === "result") {
            if (message.subtype !== "success") throw new Error(JSON.stringify(message));
            sessionId = message.session_id; success = true;
          }
        }
        if (!success || !sessionId) throw new Error("Missing successful SDK session result");
        capture.sessions.push(sessionId);
      } finally { clearTimeout(timer); await turn.finishWorker(); view.cleanup(); }
    }
    writeFileSync(join(scratch, "requests.json"), JSON.stringify({ ...captures, attachmentOutcome: { sessions: [], exchanges: [], appends: [],
      calls: host.reads(), ids: [host.permit.fileId, host.log.fileId] } }));
  } finally { host.close(); }
} finally { restore(); server.stop(true); }
