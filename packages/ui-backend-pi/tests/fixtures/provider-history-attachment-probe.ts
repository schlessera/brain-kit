/**
 * Attachment reads through a native Pi worker (#3154), inside the caller's
 * offline namespace. Turn 0 sends the host's real first message, references
 * only; the model then calls `read_attachment` through the worker pipe, and
 * the host half is the production reader and PDF extractor over real stored
 * originals. Turn 1 reads the text original, and turn 2 rereads the PDF page.
 * Tools, instructions and earlier input items must stay byte-identical.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiBackend } from "../../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";
import { fixtureBrain } from "../../../../tests/fixtures/provider-history-brain.js";
import { fixtureAttachmentHost } from "../../../ui-server/tests/fixtures/attachment-host-fixture.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import type { ReadAttachmentInput } from "@schlessera/brain-ui-sdk/tool-contracts";

const scratch = process.argv[2]!;
const captures: Captures = {};
const capture: HistoryCapture = captures.attachment = { sessions: [], exchanges: [], appends: [], calls: [] };
let turnIndex = 0, sequence = 0;
let queue: Array<{ name: string; input: Record<string, unknown> }> = [];

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/responses") throw new Error(`Unexpected Pi endpoint: ${path}`);
  const raw = await request.text();
  const step = queue.shift();
  sequence++;
  const id = `msg_odysseus_${sequence}`;
  const answer = step ? { type: "function_call", id: "fc_odysseus", call_id: `call_odysseus_${turnIndex}_${sequence}`, name: step.name, arguments: JSON.stringify(step.input) }
    : { type: "message", role: "assistant", content: [{ type: "output_text", text: "Odysseus may berth at Ithaca.", annotations: [] }], status: "completed", id };
  capture.exchanges.push({ turn: turnIndex, path, raw, main: true, answer });
  const response = { id: `resp_odysseus_${sequence}`, object: "response", status: "completed", model: "gpt-4o-mini", output: [answer],
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: step ? { ...answer, arguments: "" } : { ...answer, content: [] } },
    ...(step ? [{ type: "response.function_call_arguments.delta", item_id: "fc_odysseus", output_index: 0, delta: (answer as { arguments: string }).arguments }]
      : [{ type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: "Odysseus may berth at Ithaca." }]),
    { type: "response.output_item.done", output_index: 0, item: answer },
    { type: "response.completed", response },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1`, apiKey: "offline-odysseus" } } }));
try {
  const brain = fixtureBrain(scratch, "attachment");
  const host = fixtureAttachmentHost(brain, scratch);
  const script = [[{ name: "read_attachment", input: { id: host.permit.fileId, pages: "2" } }],
    [{ name: "read_attachment", input: { id: host.log.fileId } }],
    [{ name: "read_attachment", input: { id: host.permit.fileId, pages: "2" } }]];
  const backend = createPiBackend({ brainPath: brain, sessionDir: join(scratch, "sessions-attachment"), loadExtensions: false,
    profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }], confirmBashPatterns: [] });
  let sessionId: string | undefined;
  try {
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      queue = [...script[turnIndex]!];
      const controller = new AbortController();
      const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "strict", areas: [] });
      const frames: ServerMessage[] = [];
      const turnId = `odysseus-attachment-${turnIndex}`;
      const budget = { used: 0 };
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        await startFixtureTurn(backend, brain, { prompt: turnIndex === 0 ? host.prompt : `Odysseus reads on, step ${turnIndex}.`, profileId: "fixture", sessionId,
          signal: controller.signal, turnId, workerSandbox: sandbox,
          client: { formFactor: "tablet", viewportWidth: 800, camera: true }, turnBudgetMs: 60_000,
          bridge: { emit(frame) { frames.push(frame); }, async requestPermission() { return { behavior: "allow" as const }; },
            // The ws bridge's adapter: the context is this turn's, never the call's.
            async readAttachment(input: ReadAttachmentInput) {
              capture.calls!.push(input);
              return host.read(turnId, controller.signal, budget, input);
            } },
        });
        const result = frames.findLast(f => f.type === "result");
        if (!result || result.outcome !== "success") throw new Error(JSON.stringify(frames));
        sessionId = result.sessionId;
        capture.sessions.push(sessionId);
      } finally { clearTimeout(timer); }
    }
    writeFileSync(join(scratch, "requests.json"), JSON.stringify({ ...captures, attachmentOutcome: { sessions: [], exchanges: [], appends: [],
      calls: host.reads(), ids: [host.permit.fileId, host.log.fileId] } }));
  } finally { host.close(); }
} finally { server.stop(true); }
