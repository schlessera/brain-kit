/**
 * Apify through the installed Claude CLI (#3162). The caller confines the SDK,
 * the bundled CLI and every tool to loopback. Three resumed turns call the
 * fixed `mcp__brain-ui__brain_apify_*` tools through the CLI's MCP route; the
 * host half is the real hosted Apify service on a loopback fake of the Apify
 * API, so disablement, discovery policy, per-use review, a bounded run and
 * result retrieval are the host's own decisions. The worker never holds the
 * token. Tools, system and earlier messages must stay byte-identical.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../../ui-server/tests/helpers/fixture-native-startup.js";
import { APIFY_INPUT, APIFY_LIMITS, apifyPolicy, fakeApify, fixtureApifyHost } from "../../../ui-server/tests/fixtures/apify-host-fixture.js";
import { fixtureBrain } from "../../../../tests/fixtures/provider-history-brain.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
import type { ApifyToolCall } from "@schlessera/brain-ui-sdk/tool-contracts";

const scratch = process.argv[2]!;
const captures: Captures = {};
const capture: HistoryCapture = captures.apify = { sessions: [], exchanges: [], appends: [], calls: [], rosters: [] };
const envelopes: any[] = [];
const cards: string[] = [];
let turnIndex = 0;
/** Each turn's scripted calls, built from what the host answered before. */
const SCRIPT: Array<Array<() => { name: string; input: Record<string, unknown> }>> = [
  [() => ({ name: "brain_apify_discover", input: { query: "sea charts" } })],
  [() => ({ name: "brain_apify_discover", input: { query: "sea charts" } }),
    () => ({ name: "brain_apify_inspect", input: { candidate: envelopes.at(-1).data.candidates[0].candidate } })],
  [() => ({ name: "brain_apify_prepare", input: { candidate: envelopes[1].data.candidates[0].candidate, input: APIFY_INPUT, max_charge_usd: 2 } }),
    () => ({ name: "brain_apify_run", input: { proposal: envelopes.at(-1).data.proposal } }),
    () => ({ name: "brain_apify_results", input: { run: envelopes.at(-1).data.run, limit: 2 } })],
];
let queue: Array<() => { name: string; input: Record<string, unknown> }> = [];

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/messages") return Response.json({});
  const raw = await request.text(), body = JSON.parse(raw);
  const main = body.tools?.some((tool: any) => tool.name === "Read") === true;
  const next = main ? queue.shift() : undefined;
  const step = next?.();
  const content = step ? [{ type: "tool_use", id: `toolu_odysseus_${turnIndex}_${capture.exchanges.length}`, name: `mcp__brain-ui__${step.name}`, input: step.input }]
    : [{ type: "text", text: main ? "Odysseus reads the charts." : JSON.stringify({ title: "Odysseus reads the charts" }) }];
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
const fake = fakeApify();
const restore = replaceNativeStartupAcquisitionForFixture();
try {
  const brain = fixtureBrain(scratch, "apify");
  mkdirSync(join(scratch, "apify-private"), { mode: 0o700 });
  const host = fixtureApifyHost(brain, fake, join(scratch, "apify-private", "ledger.sqlite"));
  const home = join(scratch, "home-apify");
  mkdirSync(join(home, ".claude"), { recursive: true });
  let sessionId: string | undefined;
  try {
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      // Off by default; then catalog and Actors both ask, so every remote step is reviewed per use.
      apifyPolicy(brain, turnIndex === 0 ? null : { enabled: true, discovery: "ask", actors: "ask", limits: APIFY_LIMITS });
      queue = [...SCRIPT[turnIndex]!];
      const controller = new AbortController();
      const sandbox = prepareFixtureWorkerSandbox(brain, { home, profile: "strict", areas: [] });
      const view = createFixtureWorkerStartupView(brain);
      const turnId = `odysseus-apify-${turnIndex}`;
      const turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: {
        prompt: `Odysseus charts voyage step ${turnIndex}.`, sessionId, signal: controller.signal, turnId,
        workerStartupView: view, workerSandbox: sandbox, client: { formFactor: "tablet", viewportWidth: 800, camera: true }, turnBudgetMs: 60_000,
        bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "allow" as const }; },
          activity(event: { kind: string; prefix?: { tools: string | null } }) { if (event.kind === "prompt_prefix") capture.rosters!.push(event.prefix!.tools); },
          // The ws bridge's adapter: the context is this turn's, never the call's.
          async apify(call: ApifyToolCall) {
            capture.calls!.push(call.tool);
            const envelope = await host.call({ turnId, principalId: "p-penelope", sessionId: () => sessionId ?? null, posture: "interactive", signal: controller.signal,
              approvals: { requestPermission: async request => { cards.push(`${request.kind}:${request.toolName}`); return { behavior: "allow" }; } } }, call);
            envelopes.push(envelope);
            return envelope;
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
  } finally { host.close(); }
  writeFileSync(join(scratch, "requests.json"), JSON.stringify({ ...captures, apifyOutcome: { sessions: [], exchanges: [], appends: [],
    calls: envelopes.map(envelope => envelope.ok ? "ok" : envelope.error.code), rosters: [], cards, starts: fake.starts(),
    items: envelopes.at(-1)?.data?.items?.length ?? null } }));
} finally { restore(); fake.stop(); server.stop(true); }
