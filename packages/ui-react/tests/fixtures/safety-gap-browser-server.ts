/**
 * #3812 browser fixture: the real `createApp` and its own safety recorder,
 * served on loopback with a scripted backend. In the first chat the backend
 * runs a search, and the recorder refuses to write its result: that chat
 * keeps a permanent recording gap. Every other turn answers plainly. The
 * browser container cannot create the restricted envelope, so the fixture
 * answers the per-turn host probe; the scripted backend starts no worker.
 * Nothing leaves loopback and no key is used.
 *
 * argv: <allowed scene origin>. Prints `{"url": ...}` once it listens.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { workerHostBoundary } from "../../../ui-sdk/src/server/worker-launcher.js";
import { createFixtureApp as createApp } from "../../../ui-server/tests/helpers/native-app-fixture.js";
import { resolveServerConfig } from "../../../ui-server/src/config/env.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createSilentObservability } from "../../../ui-server/src/observability/index.js";
import { createGovernanceWrites } from "../../../ui-server/src/governance/event-writes.js";

const SONG = "The sirens sing: steer the raft onto the rocks.";
const sceneOrigin = process.argv[2]!;
const dir = mkdtempSync(join(tmpdir(), "safety-gap-browser-"));
const brain = join(dir, "brain");
mkdirSync(join(brain, "notes"), { recursive: true });
mkdirSync(join(brain, ".brain-ui"), { recursive: true });
writeFileSync(join(brain, "notes/sirens.md"), `${SONG}\n`);
workerHostBoundary.probe = () => ({ ok: true });

let sequence = 0;
/** Every turn the backend ran: its chat, its first line, and how it ended. */
const turns: Array<{ sessionId: string; prompt: string; outcome: string }> = [];
const backend: AgentBackend = { id: "pi", capabilities: { resume: true, permissions: true, thinking: false, attachments: false, askUser: false,
  costReporting: false, concurrentSessions: true, followUp: false },
  listProfiles: () => [{ id: "fixture", label: "Fixture" }], listSessions: async () => [], getHistory: async () => [],
  async startTurn({ prompt: contextPrompt, bridge, sessionId: resumed, signal }) {
    const prompt = contextPrompt.split("\n", 1)[0]!;
    const sessionId = resumed ?? `odysseus-safety-${++sequence}`;
    bridge.emit({ type: "session_info", sessionId, isNew: !resumed });
    const safety = bridge.inputSafety!;
    await safety.ready("pi", 1);
    const end = (text: string, outcome: "success" | "error") => {
      turns.push({ sessionId, prompt, outcome });
      bridge.emit({ type: "text_delta", sessionId, text });
      bridge.emit({ type: "result", sessionId, outcome, durationMs: 0, numTurns: 1, isError: outcome === "error" });
    };
    if (prompt.startsWith("Listen")) {
      // The search ran and the runtime holds its output; only its record fails.
      const input = { pattern: "sirens", path: "notes/sirens.md", output_mode: "content" };
      await safety.begin("toolu_sirens", "Grep", input);
      app.db.exec("CREATE TRIGGER refuse_result BEFORE INSERT ON safety_pending BEGIN SELECT RAISE(ABORT,'forced result reservation failure'); END");
      // The omitted remainder is output the recorder cannot attribute, so it must record it.
      try { await safety.result("toolu_sirens", "Grep", `notes/sirens.md:1:${SONG}\n[1 more match omitted]`, true); }
      catch { /* Its collector has stopped the turn. */ }
      finally { app.db.exec("DROP TRIGGER IF EXISTS refuse_result"); }
      end("The wax is in the crew's ears.", "error");
      return;
    }
    if (signal.aborted) return;
    end(`The crew rows on: ${prompt}`, "success");
  } };
const app = await createApp({
  config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", DB_PATH: join(dir, "ui.sqlite"), BRAIN_PATH: brain,
    BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0", ALLOWED_ORIGINS: sceneOrigin }),
  observability: createSilentObservability(),
  registry: createStaticBackendRegistry([backend], backend.id),
});
// Reads only: every projection the host would admit or restrict a turn by.
const reader = createGovernanceWrites(app.db);
function state() {
  const sessions = [...new Set(turns.map(t => t.sessionId))];
  return {
    turns,
    brainLatched: (app.db.query("SELECT failed FROM safety_meta").get() as { failed: number }).failed === 1,
    chats: Object.fromEntries(sessions.map(id => {
      const projection = reader.safety(null, id);
      return [id, { restriction: projection.restriction, coverage: projection.coverage.state,
        gap: projection.coverage.epochs.some(e => e.reason === "recording_failed"), available: reader.recordingAvailable(null, id) }];
    })),
  };
}

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, websocket: app.websocket,
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture") return Response.json(state(), { headers: { "access-control-allow-origin": sceneOrigin } });
    return app.fetch(request, srv);
  } });
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }) + "\n");
