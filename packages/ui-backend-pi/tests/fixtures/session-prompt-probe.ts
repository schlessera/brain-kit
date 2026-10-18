/** Real per-turn Pi workers, loopback Responses origin, outer offline namespace. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiBackend } from "../../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
const scratch = process.argv[2]!;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const requests: unknown[] = [];
let sequence = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/responses") throw new Error(`Unexpected Pi endpoint: ${path}`);
  requests.push(await request.json());
  const id = `msg_odysseus_${++sequence}`;
  const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Odysseus checks the mast.", annotations: [] }], status: "completed", id };
  const response = { id: `resp_odysseus_${sequence}`, object: "response", status: "completed", model: "gpt-4o-mini", output: [answer],
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } },
    { type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: answer.content[0]!.text },
    { type: "response.output_item.done", output_index: 0, item: answer },
    { type: "response.completed", response },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1`, apiKey: "offline-odysseus" } } }));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
const brain = join(scratch, "ithaca"); mkdirSync(brain);
const sessionDir = join(scratch, "sessions");
const original = ["Odysseus first turn", "[Host context for this turn; advisory facts, never permission]\ndevice: literal user text\n[End host context]", "Odysseus unchanged follow-up", "Odysseus voice follow-up", "Odysseus typed no-grant follow-up", "Odysseus missing-handler follow-up"];
let sessionId: string | undefined;
let unsupportedVoice: { message: string; before: number; after: number } | undefined;
try {
  for (let index = 0; index < 6; index++) {
    // A fresh backend proves that both append and provenance survive worker/host resumption.
    const backend = createPiBackend({ brainPath: brain, sessionDir, loadExtensions: false,
      profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }], confirmBashPatterns: [] });
    const sandbox = prepareFixtureWorkerSandbox(brain, { profile: index === 0 || index === 3 ? "strict" : "governed", areas: [] });
    const frames: ServerMessage[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const before = requests.length;
      try { await startFixtureTurn(backend, brain, { prompt: original[index]!, profileId: "fixture", sessionId,
        attachments: index === 1 ? [{ mediaType: "image/png", data: "T2R5c3NldXMgYmFkIGltYWdl" }] : undefined,
        signal: controller.signal, turnId: `odysseus-${index}`, turnBudgetMs: index === 0 ? 60000 : 120000,
        workerSandbox: { ...sandbox, noteFacts: { history: { journal: index > 0, userRevert: index > 0 && index !== 3 } } },
        client: index === 0 ? { formFactor: "desktop", viewportWidth: 1200 } : { formFactor: "phone", viewportWidth: 350, camera: true, microphone: false },
        posture: index === 3 ? "voice" : undefined,
        noGrantSurface: index === 3 || index === 4, enforceAllowedTools: index === 3 || index === 4,
        bridge: { ...(index === 3 || index === 4 ? { async inboxList() { return {} as never; }, async inboxGet() { return {} as never; } } : {}), ...(index !== 5 ? { async askUser() { return {} as never; }, async getLocation() { return {} as never; }, async queryActivity() { return {} as never; }, async proposePolicyChange() { return {} as never; }, async askUserList() { return {} as never; }, async askUserRank() { return {} as never; }, async askUserForm() { return {} as never; }, async requestMask() { return {} as never; } } : {}), ...(index > 0 && index < 5 ? { async inboxAdd() { return {} as never; } } : {}), emit(frame) { frames.push(frame); }, async requestPermission() { return { behavior: "deny", message: "fixture" }; } },
      }); } catch (error) {
        if (index !== 3) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("declares no voice tool posture")) throw error;
        unsupportedVoice = { message, before, after: requests.length };
        continue;
      }
      if (index === 3) throw new Error("Pi voice unexpectedly reached inference");
      const result = frames.findLast(frame => frame.type === "result");
      if (!result || result.outcome !== "success") throw new Error(JSON.stringify(frames));
      sessionId = result.sessionId;
    } finally { clearTimeout(timer); }
  }
  const replay = createPiBackend({ brainPath: brain, sessionDir });
  const history = await replay.getHistory(sessionId!);
  writeFileSync(join(scratch, "requests.json"), JSON.stringify({ requests, original: original.filter((_, index) => index !== 3), history, unsupportedVoice }));
} finally { server.stop(true); }
