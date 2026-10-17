/** Real Pi worker, local Responses endpoint, no reachable provider. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiBackend } from "../../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
const scratch = process.argv[2]!, brain = join(scratch, "brain");
mkdirSync(join(brain, "notes"), { recursive: true }); writeFileSync(join(brain, "notes/raft.md"), "Odysseus repairs the raft.");
const inputs: Record<string, unknown> = {
  request_image_mask: { imagePath: "assets/raft.png" },
  ask_user_list: { prompt: "Choose route", scale: [{ label: "Keep" }, { label: "Wait" }], items: [{ id: "raft", label: "Raft" }] },
  ask_user_rank: { prompt: "Rank routes", items: [{ id: "raft", label: "Raft" }, { id: "ship", label: "Ship" }] },
  ask_user_form: { prompt: "Plan route", nodes: [{ kind: "text", id: "route", prompt: "Which route?" }] },
  propose_policy_change: { content: "Odysseus policy", rationale: "Review route" },
  inbox_add: { text: "Repair raft", idempotencyKey: "raft" },
  resolve_action: { sessionId: "voyage", itemId: "raft", optionId: "keep", expectedVersion: 1 },
  complete_share: { receiptIds: ["raft"], files: [] },
};
const missingInputs = { brain_archive: { path: "notes/raft.md", expectedBaseHash: null }, brain_add: { content: "Odysseus plans the voyage." }, brain_update: { path: "notes/raft.md", expectedBaseHash: null, append_content: "Repair mast" }, apply_staged_changes: { files: [{ path: "notes/raft.md", expectedBaseHash: null, content: "MUTATION" }] } };
const captures: any[] = []; let active: any, next = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== "/v1/responses") throw new Error("Unexpected endpoint");
  const body = await request.json() as any; active.tools ??= body.tools;
  const selected = active.mode === "missing" ? { ...inputs, ...missingInputs } : inputs;
  const name = active.mode === "typed" ? (next === 0 ? "ask_user_list" : undefined) : Object.keys(selected)[next];
  next++;
  const id = `raft_${next}`, answer: any = name ? { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(selected[name]) }
    : { type: "message", role: "assistant", content: [{ type: "output_text", text: "Odysseus checks the mast.", annotations: [] }], status: "completed", id };
  const response = { id: `resp_${id}`, object: "response", status: "completed", model: "gpt-4o-mini", output: [answer], usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } };
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: name ? { ...answer, arguments: "" } : { ...answer, content: [] } },
    ...(name ? [{ type: "response.function_call_arguments.delta", item_id: `fc_${id}`, output_index: 0, delta: answer.arguments }] : [
      { type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: answer.content[0].text }]),
    { type: "response.output_item.done", output_index: 0, item: answer }, { type: "response.completed", response }];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1`, apiKey: "offline-odysseus" } } }));
const backend = createPiBackend({ brainPath: brain, sessionDir: join(scratch, "sessions"), loadExtensions: false,
  profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }], confirmBashPatterns: [] });
let sessionId: string | undefined;
try {
  for (const mode of ["no-grant", "typed", "missing"]) {
    active = { mode, tools: undefined, frames: [], activity: [], calls: [], cards: 0 }; captures.push(active); next = 0;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
    const bridge: any = { activity(event: unknown) { active.activity.push(event); }, emit(frame: ServerMessage) { active.frames.push(frame); }, async requestPermission() { active.cards++; return { behavior: "allow" }; } };
    if (mode !== "missing") for (const name of ["askUserList", "askUserRank", "askUserForm", "requestMask", "proposePolicyChange", "inboxList", "inboxAdd", "resolveAction", "completeShare"])
      bridge[name] = async () => { active.calls.push(name); throw new Error("PRIVILEGED_HANDLER_EXECUTED"); };
    if (mode === "typed") bridge.askUserList = async () => { active.calls.push("askUserList"); return { answers: { raft: "Keep" }, skipped: [] }; };
    try {
      await startFixtureTurn(backend, brain, { prompt: "Check voyage", profileId: "fixture", sessionId, signal: controller.signal,
        turnId: `voyage-${mode}`, noGrantSurface: mode === "no-grant", enforceAllowedTools: mode === "no-grant", workerSandbox: prepareFixtureWorkerSandbox(brain, { profile: "strict", areas: [] }), bridge });
      const result = active.frames.findLast((frame: any) => frame.type === "result");
      if (!result || result.outcome !== "success") throw new Error(JSON.stringify(active.frames));
      sessionId = result.sessionId;
    } finally { clearTimeout(timer); }
  }
  // Existing production boundary: no provider request is emitted for voice.
  const before = captures.length; let voiceRefused = false;
  try { await backend.startTurn({ prompt: "Check voyage", sessionId, signal: new AbortController().signal, posture: "voice", noGrantSurface: true, enforceAllowedTools: true,
    bridge: { emit() {}, async requestPermission() { throw new Error("VOICE_CARD"); } } }); }
  catch (error) { voiceRefused = String(error).includes("no voice tool posture"); }
  writeFileSync(join(scratch, "requests.json"), JSON.stringify({ captures, voiceRefused, unchanged: before === captures.length }));
} finally { server.stop(true); }
