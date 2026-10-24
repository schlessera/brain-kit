import { usageEvents } from "./helpers/usage-events.js";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
/**
 * Real keyless workers (#2726): a provider-denied turn neither receives the
 * project's saved auto-memory nor saves a note to it, new or replacing, and
 * its transcript still saves. A turn without provider masks keeps memory.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk";
import { prepareWorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend.js";

const SESSION = "22222222-2222-4222-8222-222222222222";
const MiB = 1024 * 1024;
/** Fictional protected text a note quoted before the provider policy existed. */
const SENTINEL = "ODYSSEUS-MEMORY-SENTINEL-NOBODY";
const NOTE = `Odysseus told the Cyclops his name was Nobody (${SENTINEL}).\n`;

async function run(denied: boolean) {
  const root = mkdtempSync(join(tmpdir(), "claude-denied-memory-"));
  const brain = join(root, "brain"), config = join(root, "claude"), index = join(root, "private-index");
  for (const dir of ["me", ".git", ".brain-index"]) mkdirSync(join(brain, dir), { recursive: true });
  mkdirSync(config); mkdirSync(index); writeFileSync(join(config, "settings.json"), "{}");
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const transcript = join(config, project, `${SESSION}.jsonl`), memory = join(config, project, "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(transcript, "{\"type\":\"user\",\"text\":\"Odysseus sets sail.\"}\n"); writeFileSync(join(memory, "MEMORY.md"), NOTE);
  const frames: ServerMessage[] = [], observed: (string | null)[] = [];
  let workerExit: Promise<number | null> | undefined, startup = "";
  const queryFn = ((params: { options?: Options }) => {
    const stream = (async function* () {
      startup = JSON.stringify(params.options?.systemPrompt ?? null);
      // The worker reports what its runtime state holds into the transcript,
      // then writes a replacement for the saved note and a new one.
      const script = [
        `T="$CLAUDE_CONFIG_DIR/$PROJECT/$SESSION.jsonl"; M="$CLAUDE_CONFIG_DIR/$PROJECT/memory"`,
        `if [ -e "$M/MEMORY.md" ]; then printf '{"memory":"present"}\\n' >> "$T"; else printf '{"memory":"absent"}\\n' >> "$T"; fi`,
        `if grep -rqs "${SENTINEL}" "$CLAUDE_CONFIG_DIR"; then printf '{"sentinel":"found"}\\n' >> "$T"; else printf '{"sentinel":"unseen"}\\n' >> "$T"; fi`,
        `mkdir -p "$M"; printf 'Penelope waits.\\n' > "$M/MEMORY.md"; printf 'Athena counsels.\\n' > "$M/athena.md"`,
        "exit 0",
      ].join("; ");
      const child = params.options!.spawnClaudeCodeProcess!({ command: "/bin/sh",
        args: ["-c", script, `--resume=${SESSION}`], cwd: brain,
        env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: config, PROJECT: project, SESSION },
        signal: new AbortController().signal } as never);
      workerExit = new Promise(resolve => child.once("exit", (code: number | null) => resolve(code)));
      (child.stdout as NodeJS.ReadableStream).resume();
      yield { type: "system", subtype: "init", session_id: SESSION, apiKeySource: "none" };
      yield* usageEvents(SESSION, "claude-sonnet-4-6", 17, 9);
      yield { type: "result", subtype: "success", session_id: SESSION, total_cost_usd: 0.25,
        duration_ms: 123, num_turns: 1, result: "Ithaca", usage: { input_tokens: 17, output_tokens: 9 } };
    })();
    return Object.assign(stream, { initializationResult: async () => ({
      account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }) });
  }) as unknown as typeof query;
  try {
    const workerStartupView = createFixtureWorkerStartupView(brain);
    const backend = createClaudeBackend({ brainPath: brain, queryFn, workerState: { allowanceBytes: 4 * MiB, budgetBytes: 4 * MiB } });
    // The host's admitted masks; a turn without provider rules has none.
    const workerSandbox = { ...prepareWorkerSandbox(brain, {}), ...(denied ? { providerMasks: { folders: ["me"], index } } : {}) };
    let backendError: unknown;
    try {
      await backend.startTurn({ workerStartupView, workerSandbox, prompt: "Return to Ithaca", signal: new AbortController().signal,
        persistClaudeMemory: (change, save) => { observed.push(change?.note ?? null); if (change) save(); },
        bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } }).catch(error => { backendError = error; });
    } finally { workerStartupView.cleanup(); }
    expect(backendError).toBeUndefined();
    expect(await workerExit).toBe(0);
    const lines = readFileSync(transcript, "utf8").trim().split("\n").slice(1).map(line => JSON.parse(line));
    return { startup, observed, lines, results: frames.filter(frame => frame.type === "result"),
      note: readFileSync(join(memory, "MEMORY.md"), "utf8"), athena: existsSync(join(memory, "athena.md")) ? readFileSync(join(memory, "athena.md"), "utf8") : null };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a provider-denied worker never sees saved auto-memory and saves no note, while its transcript saves", async () => {
  const { startup, observed, lines, results, note, athena } = await run(true);
  expect(lines[0], "DENIED_WORKER_HAS_NO_SAVED_MEMORY").toEqual({ memory: "absent" });
  expect(lines[1], "DENIED_WORKER_CANNOT_READ_MEMORY_SENTINEL").toEqual({ sentinel: "unseen" });
  expect(startup, "DENIED_STARTUP_CONTEXT_HAS_NO_SENTINEL").not.toContain(SENTINEL);
  expect(note, "DENIED_REPLACEMENT_NOTE_NOT_SAVED").toBe(NOTE);
  expect(athena, "DENIED_NEW_NOTE_NOT_SAVED").toBeNull();
  expect(observed, "DENIED_NO_MEMORY_PERSISTENCE_OBSERVED").toEqual([]);
  // No omission-induced concurrent-memory refusal: the turn completes normally.
  expect(results, "DENIED_TRANSCRIPT_COMPLETES").toMatchObject([{ outcome: "success", isError: false }]);
});

test("paired control: a worker without provider masks reads saved memory and saves its notes", async () => {
  const { observed, lines, results, note, athena } = await run(false);
  expect(lines[0], "ALLOWED_WORKER_HAS_SAVED_MEMORY").toEqual({ memory: "present" });
  expect(lines[1], "ALLOWED_WORKER_READS_MEMORY").toEqual({ sentinel: "found" });
  expect(note, "ALLOWED_REPLACEMENT_NOTE_SAVED").toBe("Penelope waits.\n");
  expect(athena, "ALLOWED_NEW_NOTE_SAVED").toBe("Athena counsels.\n");
  expect(observed.sort()).toEqual(["MEMORY.md", "athena.md"]);
  expect(results).toMatchObject([{ outcome: "success", isError: false }]);
});
