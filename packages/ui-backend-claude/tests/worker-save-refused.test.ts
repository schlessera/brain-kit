/** Real keyless workers: copy-out refuses after the runtime reported success (#1697). */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";
import { workerStateSaveFailure } from "../src/worker-state.js";
import { createClaudeBackend } from "../src/backend.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const MiB = 1024 * 1024;
type Mode = "concurrent" | "hardlink" | "valid" | "exceeded" | "memory";

async function run(mode: Mode, cancel = false) {
  const root = mkdtempSync(join(tmpdir(), "claude-save-refused-"));
  const brain = join(root, "brain"), config = join(root, "claude");
  mkdirSync(brain); mkdirSync(config); writeFileSync(join(config, "settings.json"), "{}");
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const saved = join(config, project, `${SESSION}.jsonl`);
  const memory = join(config, project, "memory", "MEMORY.md");
  mkdirSync(join(config, project, "memory"), { recursive: true });
  writeFileSync(saved, "Odysseus\n"); writeFileSync(memory, "Athena\n");
  const frames: ServerMessage[] = [], host = new AbortController();
  let workerExit: Promise<number | null> | undefined, backendError: unknown;
  const queryFn = ((params: { options?: Options }) => {
    const stream = (async function* () {
      const script = `printf 'Ithaca\\n' >> "$CLAUDE_CONFIG_DIR/$PROJECT/$SESSION.jsonl"; `
        + (mode === "hardlink" ? `ln "$CLAUDE_CONFIG_DIR/$PROJECT/$SESSION.jsonl" "$CLAUDE_CONFIG_DIR/$PROJECT/alias"; ` : "")
        + (mode === "memory" ? `printf 'Penelope\\n' > "$CLAUDE_CONFIG_DIR/$PROJECT/memory/MEMORY.md"; ` : "")
        + (mode === "exceeded" ? `head -c ${4 * MiB} /dev/zero > "$CLAUDE_CONFIG_DIR/flood" 2>/dev/null; ` : "")
        + "exit 0";
      const child = params.options!.spawnClaudeCodeProcess!({ command: "/bin/sh",
        args: ["-c", script, `--resume=${SESSION}`], cwd: brain,
        env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: config, PROJECT: project, SESSION },
        signal: new AbortController().signal } as never);
      workerExit = new Promise(resolve => child.once("exit", (code: number | null) => resolve(code)));
      (child.stdout as NodeJS.ReadableStream).resume();
      // The real snapshot has been populated; alter only the saved host copy.
      if (mode === "concurrent" || mode === "exceeded") writeFileSync(saved, "Telemachus\n");
      if (mode === "memory") writeFileSync(memory, "Telemachus\n");
      yield { type: "system", subtype: "init", session_id: SESSION, apiKeySource: "none" };
      yield { type: "result", subtype: "success", session_id: SESSION, total_cost_usd: 0.25,
        duration_ms: 123, num_turns: 1, result: "Ithaca", usage: { input_tokens: 17, output_tokens: 9 } };
      if (cancel) host.abort();
    })();
    return Object.assign(stream, { initializationResult: async () => ({
      account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }) });
  }) as unknown as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: brain, queryFn,
      workerState: { allowanceBytes: 4 * MiB, budgetBytes: 4 * MiB } });
    await backend.startTurn({ prompt: "Return to Ithaca", signal: host.signal,
      bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } }).catch(error => { backendError = error; });
    if (!cancel) expect(await workerExit).toBe(0);
    return { backendError, results: frames.filter(f => f.type === "result"), saved: readFileSync(saved, "utf8"), memory: readFileSync(memory, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const mode of ["concurrent", "hardlink", "memory"] as const) {
  test(`refused ${mode} copy-out replaces success with one named failure and keeps usage`, async () => {
    const { results, saved, memory, backendError } = await run(mode);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "error", isError: true, costUsd: 0.25,
      durationMs: 123, numTurns: 1, failure: { errorClass: "worker_state_save_refused" } });
    expect(backendError).toBeUndefined();
    expect(results[0]!.failure!.message).toContain("not saved in full");
    expect(results[0]!.failure!.message).not.toMatch(/\/tmp\/|too (?:large|long)|nothing was sent/i);
    if (mode === "concurrent") expect(saved).toBe("Telemachus\n");
    if (mode === "memory") {
      expect(saved).toBe("Odysseus\nIthaca\n");
      expect(memory).toBe("Telemachus\n");
    }
  });
}

test("valid copy-out keeps success and the saved transcript", async () => {
  const { results, saved } = await run("valid");
  expect(results).toMatchObject([{ outcome: "success", costUsd: 0.25 }]);
  expect(saved).toBe("Odysseus\nIthaca\n");
});

test("exhaustion keeps its specific class with copy-out refusal disclosure", async () => {
  const { results } = await run("exceeded");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ outcome: "error", failure: { errorClass: "worker_state_exceeded" } });
  expect(results[0]!.failure!.message).toContain("could not be saved in full");
  expect(results[0]!.failure!.message).not.toContain("What it wrote before then is kept");
});

test("host cancellation outranks refused copy-out", async () => {
  const { results } = await run("concurrent", true);
  expect(results).toHaveLength(1);
  expect(results[0]).not.toHaveProperty("failure.errorClass", "worker_state_save_refused");
});


test("copy-out disclosure never forwards arbitrary filesystem paths or memory names", () => {
  for (const error of [new Error("EACCES /tmp/odysseus/private"),
    new WorkerHostError("saved memory changed concurrently; refusing overwrite of memory/odysseus-private.md")]) {
    const failure = workerStateSaveFailure(error);
    expect(failure.errorClass).toBe("worker_state_save_refused");
    expect(failure.message).toContain("not saved in full");
    expect(failure.message).not.toContain("odysseus-private");
    expect(failure.message).not.toContain("/tmp/");
  }
  expect(workerStateSaveFailure(new WorkerHostError("runtime transcripts and memory exceed their byte bound")).message)
    .toContain("exceeded a copy-out bound");
});
