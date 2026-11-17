/**
 * Apify through a native Pi worker (#3162), inside the caller's offline
 * namespace. Three resumed turns call the fixed `brain_apify_*` tools through
 * the worker pipe; the host half is the real hosted Apify service on a
 * loopback fake of the Apify API, so disablement, discovery policy, per-use
 * review, a bounded run and result retrieval are the host's own decisions.
 * The worker never holds the token. Tools, instructions and earlier input
 * items must stay byte-identical.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiBackend } from "../../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";
import { fixtureBrain } from "../../../../tests/fixtures/provider-history-brain.js";
import { APIFY_INPUT, APIFY_LIMITS, apifyPolicy, fakeApify, fixtureApifyHost } from "../../../ui-server/tests/fixtures/apify-host-fixture.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import type { ApifyToolCall } from "@schlessera/brain-ui-sdk/tool-contracts";

const scratch = process.argv[2]!;
const captures: Captures = {};
const capture: HistoryCapture = captures.apify = { sessions: [], exchanges: [], appends: [], calls: [] };
const envelopes: any[] = [];
const cards: string[] = [];
let turnIndex = 0, sequence = 0;
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
  if (path !== "/v1/responses") throw new Error(`Unexpected Pi endpoint: ${path}`);
  const raw = await request.text();
  const step = queue.shift()?.();
  sequence++;
  const id = `msg_odysseus_${sequence}`;
  const answer = step ? { type: "function_call", id: "fc_odysseus", call_id: `call_odysseus_${turnIndex}_${sequence}`, name: step.name, arguments: JSON.stringify(step.input) }
    : { type: "message", role: "assistant", content: [{ type: "output_text", text: "Odysseus reads the charts.", annotations: [] }], status: "completed", id };
  capture.exchanges.push({ turn: turnIndex, path, raw, main: true, answer });
  const response = { id: `resp_odysseus_${sequence}`, object: "response", status: "completed", model: "gpt-4o-mini", output: [answer],
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: step ? { ...answer, arguments: "" } : { ...answer, content: [] } },
    ...(step ? [{ type: "response.function_call_arguments.delta", item_id: "fc_odysseus", output_index: 0, delta: (answer as { arguments: string }).arguments }]
      : [{ type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: "Odysseus reads the charts." }]),
    { type: "response.output_item.done", output_index: 0, item: answer },
    { type: "response.completed", response },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1`, apiKey: "offline-odysseus" } } }));
const fake = fakeApify();
try {
  const brain = fixtureBrain(scratch, "apify");
  mkdirSync(join(scratch, "apify-private"), { mode: 0o700 });
  const host = fixtureApifyHost(brain, fake, join(scratch, "apify-private", "ledger.sqlite"));
  const backend = createPiBackend({ brainPath: brain, sessionDir: join(scratch, "sessions-apify"), loadExtensions: false,
    profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }], confirmBashPatterns: [] });
  let sessionId: string | undefined;
  try {
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      // Off by default; then catalog and Actors both ask, so every remote step is reviewed per use.
      apifyPolicy(brain, turnIndex === 0 ? null : { enabled: true, discovery: "ask", actors: "ask", limits: APIFY_LIMITS });
      queue = [...SCRIPT[turnIndex]!];
      const controller = new AbortController();
      const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "strict", areas: [] });
      const frames: ServerMessage[] = [];
      const turnId = `odysseus-apify-${turnIndex}`;
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        await startFixtureTurn(backend, brain, { prompt: `Odysseus charts voyage step ${turnIndex}.`, profileId: "fixture", sessionId,
          signal: controller.signal, turnId, workerSandbox: sandbox,
          client: { formFactor: "tablet", viewportWidth: 800, camera: true }, turnBudgetMs: 60_000,
          bridge: { emit(frame) { frames.push(frame); }, async requestPermission() { return { behavior: "allow" as const }; },
            // The ws bridge's adapter: the context is this turn's, never the call's.
            async apify(call: ApifyToolCall) {
              capture.calls!.push(call.tool);
              const envelope = await host.call({ turnId, principalId: "p-penelope", sessionId: () => sessionId ?? null, posture: "interactive", signal: controller.signal,
                approvals: { requestPermission: async request => { cards.push(`${request.kind}:${request.toolName}`); return { behavior: "allow" }; } } }, call);
              envelopes.push(envelope);
              return envelope;
            } },
        });
        const result = frames.findLast(f => f.type === "result");
        if (!result || result.outcome !== "success") throw new Error(JSON.stringify(frames));
        sessionId = result.sessionId;
        capture.sessions.push(sessionId);
      } finally { clearTimeout(timer); }
    }
  } finally { host.close(); }
  writeFileSync(join(scratch, "requests.json"), JSON.stringify({ ...captures, apifyOutcome: { sessions: [], exchanges: [], appends: [],
    calls: envelopes.map(envelope => envelope.ok ? "ok" : envelope.error.code), cards, starts: fake.starts(),
    items: envelopes.at(-1)?.data?.items?.length ?? null } }));
} finally { fake.stop(); server.stop(true); }
