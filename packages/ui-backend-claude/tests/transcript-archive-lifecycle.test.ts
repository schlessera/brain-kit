import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeBackend } from "../src/backend.js";
import { transcriptPaths } from "../src/transcript-archive.js";
import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";

mockWorkerHostForSdkStream();
test("turn completion archives idle history but excludes the runner's activeTurns", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-archive-lifecycle-"));
  const brain = join(root, "brain"); mkdirSync(brain);
  const env = { CLAUDE_CONFIG_DIR: join(root, "config") };
  const { live, archive } = transcriptPaths(brain, env); mkdirSync(live, { recursive: true });
  const running = "11111111-1111-4111-8111-111111111111";
  const completed = "22222222-2222-4222-8222-222222222222";
  const idle = "33333333-3333-4333-8333-333333333333";
  const old = new Date("2026-06-01T00:00:00Z");
  for (const id of [running, idle]) {
    writeFileSync(join(live, `${id}.jsonl`), "Odysseus\n");
    utimesSync(join(live, `${id}.jsonl`), old, old);
  }
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const backend = createClaudeBackend({ brainPath: brain,
    profiles: [{ id: "voyage", label: "Voyage", billing: "api", requiredEnvKeys: [], buildEnv: () => env }],
    listSessionsFn: async () => [running, idle].map(sessionId => ({ sessionId, summary: "Return to Ithaca", lastModified: old.getTime(), fileSize: 9 })),
    queryFn: (({ options }: any) => (async function* () {
      if (options.resume === running) await wait;
      yield { type: "result", subtype: "success", session_id: options.resume, is_error: false,
        duration_ms: 1, duration_api_ms: 0, num_turns: 1, result: "", total_cost_usd: 0, usage: {}, modelUsage: {} };
    })()) as never,
  });
  const start = (sessionId: string) => backend.startTurn({ prompt: "Return to Ithaca", sessionId,
    signal: new AbortController().signal, bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } });
  const active = start(running);
  try {
    await start(completed);
    expect(existsSync(join(live, `${running}.jsonl`))).toBe(true);
    expect(existsSync(join(archive, running))).toBe(false);
    expect(existsSync(join(live, `${idle}.jsonl`))).toBe(false);
    expect(existsSync(join(archive, idle, `${idle}.jsonl.gz`))).toBe(true);
  } finally {
    release(); await active;
    rmSync(root, { recursive: true, force: true });
  }
});
