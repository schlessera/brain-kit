import { createFixtureWorkerStartupView, createFixtureMaintenanceHost } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
/** Keyless selected-runtime assembly receipt; caller denies all external network. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";

const scratch = process.argv[2]!;
const requests: Array<{ tools?: unknown[]; system?: unknown; messages?: unknown[] }> = [];
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return new Response("{}", { headers: { "content-type": "application/json" } });
  const q = await request.json() as { tools?: unknown[]; system?: unknown; messages?: unknown[] };
  if (q.tools?.length) requests.push(q);
  const events = [
    { type: "message_start", message: { id: "msg_odysseus", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus staged the finding." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
try {
  for (const billing of ["api", "subscription"] as const) {
    const brainPath = join(scratch, `ithaca-${billing}`);
    const home = join(scratch, `home-${billing}`);
    mkdirSync(join(brainPath, ".claude"), { recursive: true }); mkdirSync(home);
    // The host flag must outrank a project that requests the changing context.
    writeFileSync(join(brainPath, ".claude/settings.json"), JSON.stringify({ includeGitInstructions: true }));
    const git = (...args: string[]) => {
      const child = Bun.spawnSync(["git", "-C", brainPath, ...args], { env: { PATH: process.env.PATH!, HOME: home } });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    };
    git("init", "-b", "odysseus-cache-branch");
    git("config", "user.name", "Odysseus"); git("config", "user.email", "odysseus@example.invalid");
    writeFileSync(join(brainPath, "voyage.md"), "Odysseus prepares the raft.");
    git("add", "."); git("commit", "-m", "Odysseus cache first commit");
    let sessionId: string | undefined;
    for (let index = 0; index < 2; index++) {
      if (index) {
        writeFileSync(join(brainPath, "voyage.md"), "Odysseus launches the raft.");
        git("add", "."); git("commit", "-m", "Odysseus cache changed commit");
        writeFileSync(join(brainPath, "dirty-note.md"), "Penelope records the tide.");
      }
      const abortController = new AbortController();
      const workerStartupView = createFixtureWorkerStartupView(brainPath);
      const maintenance = createFixtureMaintenanceHost(brainPath);
      const turn = createClaudeSdkTurn({
        backend: { brainPath, maintenance },
        req: { workerStartupView, sessionId, prompt: `Odysseus turn ${index}`, signal: abortController.signal,
          turnBudgetMs: 10000,
          bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "deny", message: "no grant" }; } } } as never,
        profile: { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing, requiredEnvKeys: [],
          buildEnv: () => ({ HOME: home, CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
            ...(billing === "api" ? { ANTHROPIC_API_KEY: "sk-odysseus-fixture" } : { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-odysseus-fixture" }) }) },
        abortController, allowedTools: ["Read"], confirmPatterns: [],
        turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
      });
      const timer = setTimeout(() => abortController.abort(), 45_000);
      try {
        let success = false;
        for await (const message of query({ prompt: turn.prompt, options: turn.options })) {
          if (message.type === "system" && message.subtype === "init") {
            if (sessionId && message.session_id !== sessionId) throw new Error("Fixture resumed a different session");
            sessionId = message.session_id;
            console.log(`CLI ${message.claude_code_version}`);
          }
          if (message.type === "result") { if (message.subtype !== "success") throw new Error(JSON.stringify(message)); success = true; }
        }
        if (!success || !sessionId) throw new Error("No successful fixture inference session");
      } finally { clearTimeout(timer); await turn.finishWorker(); workerStartupView.cleanup(); maintenance.cleanup(); }
    }
  }
  writeFileSync(join(scratch, "requests.json"), JSON.stringify(requests));
} finally { upstream.stop(true); }
