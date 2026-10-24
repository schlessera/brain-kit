/**
 * A strict pi turn's sequential `edit_file` calls through real host apply
 * (#2831): the actual pi worker under the actual launcher, the hosted app's
 * application route and its re-index, the turn journal and the scope monitor.
 * Inference is a keyless loopback fixture reached only through the host relay,
 * which alone holds the fixture key.
 *
 * Every apply refreshes the index, rewriting `.brain-index/brain.db` whole.
 * The byte cap is four index sizes, so charging each refreshed version paused
 * (froze) the worker on a scope cap within four edits: a stall, not an error.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import { createFixtureApp } from "./helpers/native-app-fixture.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { createPrincipal } from "../src/db/principals.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";

const EDITS = 16;
/** Each answered edit must bring the next model request within this bound. */
const STEP_MS = 20_000;
const HOST_KEY = "odysseus-offline-host-key";
const MODEL = "claude-sonnet-4-6";

test(`strict pi: ${EDITS} sequential edit_file host applies each return to the model`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-pi-strict-edits-")), brain = join(root, "brain"), agent = join(root, "pi");
  const prior = { agent: process.env.PI_CODING_AGENT_DIR, origins: process.env.BRAIN_UI_PI_CREDENTIAL_ORIGINS };
  let server: ReturnType<typeof Bun.serve> | undefined, app: Awaited<ReturnType<typeof createFixtureApp>> | undefined;
  const frames: ServerMessage[] = [];
  try {
    await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
    mkdirSync(agent); mkdirSync(join(brain, "context/policies"), { recursive: true });
    for (let i = 0; i < EDITS; i++) writeFileSync(join(brain, `notes/ithaca-${i}.md`), `---\ntype: note\ntitle: Ithaca ${i}\nupdated: 2026-07-12\n---\nTelemachus writes ${i}.\n`);
    const repo = resolve(import.meta.dir, "../../..");
    const indexed = Bun.spawnSync([process.execPath, join(repo, "packages/core/src/cli/brain.ts"), "index", "--force", "--json"], { cwd: brain,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", BRAIN_ROOT: brain }, stdout: "pipe", stderr: "pipe" });
    expect(indexed.exitCode, indexed.stderr.toString()).toBe(0);
    const indexBytes = statSync(join(brain, ".brain-index/brain.db")).size;
    let requests = 0;
    const results: { content: unknown; isError: boolean }[] = [];
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 16 * 1024 ** 2, async fetch(request) {
      if (request.headers.get("x-api-key") !== HOST_KEY) return new Response("fixture key required", { status: 401 });
      const body = await request.json() as { messages: { role: string; content: string | { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[] }[] };
      const step = requests++;
      for (const message of body.messages) if (Array.isArray(message.content)) for (const block of message.content) {
        if (block.type === "tool_result" && block.tool_use_id === `ithaca-edit-${step - 1}`) results.push({ content: block.content, isError: block.is_error === true });
      }
      const sse: object[] = [{ type: "message_start", message: { id: `odysseus-${step}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
      if (step < EDITS) {
        const path = `notes/ithaca-${step}.md`;
        const expectedBaseHash = createHash("sha256").update(readFileSync(join(brain, path))).digest("hex");
        sse.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `ithaca-edit-${step}`, name: "edit_file", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path, old_string: "writes", new_string: "edits", expectedBaseHash }) } });
      } else sse.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus records every edit." } });
      sse.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: step < EDITS ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" });
      return new Response(sse.map(frame => `event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    writeFileSync(join(agent, "settings.json"), "{}");
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: HOST_KEY } } }));
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.BRAIN_UI_PI_CREDENTIAL_ORIGINS = `anthropic=http://127.0.0.1:${server.port}`;
    const backend = createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions"), loadExtensions: false, model: `anthropic/${MODEL}` });
    app = await createFixtureApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: join(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test",
      BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0", PI_CODING_AGENT_DIR: agent }),
      registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
    const cap = indexBytes * 4;
    writeFileSync(join(brain, "context/policies/governance.md"), `---\nschema_version: 1\nprofiles: { interactive: strict }\nscope: { max_bytes_written: ${cap} }\n---\nAthena keeps the turn strict.\n`);
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus edits", ttlSeconds: 600 });
    const ws = { send: (raw: string) => { frames.push(JSON.parse(raw)); }, close() {} }, handlers = createWsHandlers(app.wsHost, principal);
    await handlers.onOpen(undefined as never, ws);
    await handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Odysseus edits every Ithaca note.", requestId: "odysseus-edits" }) } as MessageEvent, ws);
    const journal = () => frames.filter((frame): frame is Extract<ServerMessage, { type: "turn_journal" }> => frame.type === "turn_journal").at(-1)?.journal;
    // Bounded watchdog: a turn that stops making model requests fails here, with its scope state.
    let seen = 0, progressAt = Date.now();
    while (!frames.some(frame => frame.type === "result")) {
      if (requests !== seen) { seen = requests; progressAt = Date.now(); }
      if (Date.now() - progressAt > STEP_MS) throw new Error(`STRICT_PI_EDIT_STALLED after ${results.length} answered edits: ${JSON.stringify({ scope: journal()?.scope, errors: frames.filter(frame => frame.type === "error") })}`);
      await Bun.sleep(50);
    }
    const session = frames.find((frame): frame is Extract<ServerMessage, { type: "session_info" }> => frame.type === "session_info");
    expect(session?.workerProfile?.actualProfile, "STRICT_PI_TURN_RAN_STRICT").toBe("strict");
    expect(frames.find(frame => frame.type === "result"), JSON.stringify(frames.filter(frame => frame.type === "error"))).toMatchObject({ isError: false });
    expect(requests, "STRICT_PI_EVERY_EDIT_RETURNED_TO_THE_MODEL").toBe(EDITS + 1);
    expect(results.map(result => result.isError), "STRICT_PI_EVERY_EDIT_SUCCEEDED").toEqual(Array(EDITS).fill(false));
    for (const result of results) expect(JSON.stringify(result.content), "STRICT_PI_EDIT_WENT_THROUGH_HOST_APPLY").toContain("Applied authoritative Markdown and updated its index.");
    for (let i = 0; i < EDITS; i++) expect(readFileSync(join(brain, `notes/ithaca-${i}.md`), "utf8"), "STRICT_PI_EDIT_ON_DISK").toContain(`Telemachus edits ${i}.`);
    expect(journal()?.scope, "STRICT_PI_INDEX_REFRESHES_NEVER_REACH_THE_CAP").toMatchObject({ receipts: [], limits: { turn_bytes: cap } });
    expect(journal()!.scope!.observedBytes!, "STRICT_PI_OBSERVED_BYTES_BELOW_CAP").toBeLessThan(cap);
  } finally {
    try { await app?.close(); }
    finally {
      server?.stop(true);
      if (prior.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior.agent;
      if (prior.origins === undefined) delete process.env.BRAIN_UI_PI_CREDENTIAL_ORIGINS; else process.env.BRAIN_UI_PI_CREDENTIAL_ORIGINS = prior.origins;
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 120_000);
