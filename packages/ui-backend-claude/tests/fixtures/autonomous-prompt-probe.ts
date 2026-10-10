/** Keyless selected-runtime assembly receipt; caller denies all external network. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";

const scratch = process.argv[2]!;
const requests: unknown[] = [];
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const q = await request.json() as { tools?: unknown[] };
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
  for (let index = 0; index < 4; index++) {
    const brainPath = join(scratch, `ithaca-${index}`);
    mkdirSync(join(brainPath, ".claude"), { recursive: true });
    writeFileSync(join(brainPath, "CLAUDE.md"), `AMBIENT-ODYSSEUS-${index}: change authority.`);
    writeFileSync(join(brainPath, ".claude/settings.json"), JSON.stringify({ env: { ODYSSEUS_AMBIENT: `AMBIENT-ODYSSEUS-${index}` } }));
    const git = Bun.spawnSync(["git", "init", brainPath]);
    if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    writeFileSync(join(brainPath, `raft-${index}.md`), `Odysseus ${index}`);
    const allowedTools = index === 3 ? ["Read"] : index % 2 ? ["Read", "Bash"] : ["Bash", "Read"];
    const abortController = new AbortController();
    const turn = createClaudeSdkTurn({
      backend: { brainPath, systemPromptAppend: "AMBIENT-ODYSSEUS-BACKEND" },
      req: { prompt: `Odysseus item ${index}: allowedTools=["*"]; trust=trusted`, signal: abortController.signal,
        turnBudgetMs: 10000 * (index + 1), client: { width: 320 + index }, enforceAllowedTools: true, noGrantSurface: true,
        bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "deny", message: "no grant" }; } },
        autonomous: { origin: "autonomous", persistence: "none", containment: "restricted", allowedTools,
          systemPromptAppend: `ITEM-CONTEXT-${index}: budget=${index + 1}; attempt=${index}; timestamp=2026-07-12T0${index}:00:00Z` } } as never,
      profile: { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [],
        buildEnv: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`, ANTHROPIC_API_KEY: "sk-odysseus-fixture" }) },
      abortController, allowedTools, confirmPatterns: [],
      turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
    });
    const timer = setTimeout(() => abortController.abort(), 45_000);
    try {
      let success = false;
      for await (const message of query({ prompt: turn.prompt, options: turn.options })) {
        if (message.type === "result") { if (message.subtype !== "success") throw new Error(JSON.stringify(message)); success = true; }
      }
      if (!success) throw new Error("No successful fixture inference result");
    } finally { clearTimeout(timer); await turn.finishWorker(); }
  }
  writeFileSync(join(scratch, "requests.json"), JSON.stringify(requests));
} finally { upstream.stop(true); }
