/** A turn settles only after its session's observation saves have (#2416). */
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeBackend } from "../src/backend.js";
import { transcriptPaths } from "../src/transcript-archive.js";
import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";

mockWorkerHostForSdkStream();
test("a new session's turn settles after its observation record is durable, not before", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-observation-settlement-"));
  const brain = join(root, "brain"); mkdirSync(brain);
  const env = { CLAUDE_CONFIG_DIR: join(root, "config") };
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const warnings: string[] = [];
  const backend = createClaudeBackend({ brainPath: brain,
    profiles: [{ id: "voyage", label: "Voyage", billing: "api", requiredEnvKeys: [], buildEnv: () => env }],
    listSessionsFn: async () => [],
    log: (level, message) => { if (level === "warn") warnings.push(message); },
    queryFn: (() => (async function* () {
      yield { type: "system", subtype: "init", session_id: sessionId };
      yield { type: "result", subtype: "success", session_id: sessionId, is_error: false,
        duration_ms: 1, duration_api_ms: 0, num_turns: 1, result: "", total_cost_usd: 0, usage: {}, modelUsage: {} };
    })()) as never,
  });
  // A loaded host's fsync: the save would otherwise outlive the turn.
  const probe = await open(tmpdir(), "r"), handle = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  const sync = handle.sync;
  const delayed = spyOn(handle, "sync").mockImplementation(async function (this: unknown) { await Bun.sleep(30); return sync.call(this); });
  try {
    await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal,
      bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } } as never);
    const storage = join(transcriptPaths(brain, env).archive, "native-observations");
    const records = existsSync(storage) ? readdirSync(storage).filter(name => name.endsWith(".json")) : [];
    expect(records, "TURN_SETTLES_AFTER_OBSERVATION_SAVE").toHaveLength(1);
  } finally {
    delayed.mockRestore();
    // Teardown right after settlement, as every test does: nothing may still be writing.
    rmSync(root, { recursive: true, force: true });
    await Bun.sleep(200);
  }
  expect(warnings.filter(message => message.includes("could not be retained")), "NO_OBSERVATION_SAVE_OUTLIVES_ITS_TURN").toEqual([]);
});
