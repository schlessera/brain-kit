/** Actual keyless namespace, admission copy and result; only the provider stream is a fixture. */
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createClaudeBackend } from "../src/backend.js";
import { processStateLedger } from "../src/worker-state-budget.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PAGE = 4096;
for (const [percent, failedStart, voice] of [[50, false, false], [80, false, false], [80, false, true], [80, true, false]] as const)
test(`${percent}% resumed state${voice ? " voice" : ""}${failedStart ? " failed start" : ""}: actual copy and cleanup create no legacy host directory`, async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-state-warning-"));
  const brain = join(root, "brain"), config = join(root, "config");
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  mkdirSync(brain); mkdirSync(join(config, project), { recursive: true });
  writeFileSync(join(config, "settings.json"), "{}");
  const allowance = 100 * PAGE, used = percent * PAGE;
  writeFileSync(join(config, project, `${SESSION}.jsonl`), "x".repeat(used - PAGE));
  // Owned unknown-ownership leftovers stand untouched. No real /dev/shm
  // listing, production state, retrospective PID inference or marker format.
  const legacy = join(root, "brain-claude-state-odysseus"); mkdirSync(legacy);
  writeFileSync(join(legacy, "unknown-owner"), "Odysseus: retain unknown ownership.");
  const created = spyOn(fs, "mkdtempSync");
  const directories = spyOn(fs, "mkdirSync");
  const frames: ServerMessage[] = [];
  let note: unknown;
  let exited: Promise<number | null> | undefined;
  const queryFn = ((params: { options: Options }) => {
    const stream = (async function* () {
      const child = params.options.spawnClaudeCodeProcess!({ command: failedStart ? "/nonexistent-odysseus-runtime" : "/bin/sh",
        args: ["-c", `test "$(wc -c < \"$CLAUDE_CONFIG_DIR/$PROJECT/$SESSION.jsonl\")" -eq ${used - PAGE}`, `--resume=${SESSION}`],
        cwd: brain, env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: config, PROJECT: project, SESSION }, signal: new AbortController().signal } as never);
      exited = new Promise(resolve => child.once("exit", (code: number | null) => resolve(code)));
      child.stdout.resume();
      const hook = params.options.hooks!.UserPromptSubmit!.at(-1)!.hooks[0]!;
      note = await hook({ hook_event_name: "UserPromptSubmit" } as never, undefined, { signal: new AbortController().signal });
      if (failedStart && await exited !== 0) throw new Error("Fixture runtime failed to start");
      yield { type: "system", subtype: "init", session_id: SESSION, apiKeySource: "none" };
      yield { type: "result", subtype: "success", session_id: SESSION, total_cost_usd: 0,
        duration_ms: 1, num_turns: 1, result: "Ithaca", usage: { input_tokens: 1, output_tokens: 1 } };
    })();
    return Object.assign(stream, { initializationResult: async () => ({ account: { tokenSource: "none", apiProvider: "firstParty" } }) });
  }) as unknown as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: brain, queryFn, workerState: { allowanceBytes: allowance, budgetBytes: allowance } });
    await backend.startTurn({ sessionId: SESSION, prompt: "Return to Ithaca", signal: new AbortController().signal,
      ...(voice ? { posture: "voice", enforceAllowedTools: true, noGrantSurface: true, allowedTools: ["Read"] } : {}),
      bridge: { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "allow" }) } }).catch(error => { if (!failedStart) throw error; });
    expect(await exited, "actual worker exit is not assumed").toBe(failedStart ? 127 : 0);
    expect(created.mock.calls.some(([prefix]) => String(prefix).includes("brain-claude-state-")), "STATE_ROOM_NO_NEW_LEGACY_HOST_DIRECTORY").toBe(false);
    expect(directories.mock.calls.some(([path]) => String(path).includes("brain-claude-state-")), "STATE_ROOM_NO_NEW_LEGACY_HOST_DIRECTORY").toBe(false);
    expect(fs.readFileSync(join(legacy, "unknown-owner"), "utf8")).toBe("Odysseus: retain unknown ownership.");
    expect(processStateLedger().live, "normal and failed starts release admission").toBe(0);
    if (failedStart) {
      expect(frames.some(frame => frame.type === "error" || frame.type === "result" && frame.isError)).toBe(true);
      return;
    }
    const result = frames.find(frame => frame.type === "result");
    expect(result, "STATE_ROOM_RESULT_FROM_ACTUAL_COPY").toHaveProperty("stateRoom", { usedBytes: used, allowanceBytes: allowance, observedAt: expect.any(Number) });
    if (percent === 80) {
      expect(note, "STATE_ROOM_AGENT_NOTE_FROM_ACTUAL_COPY").toHaveProperty("hookSpecificOutput");
      const output = (note as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
      expect(output.hookEventName).toBe("UserPromptSubmit");
      expect(output.additionalContext, "STATE_ROOM_AGENT_NOTE_FROM_ACTUAL_COPY").toContain("0.313 MiB of 0.391 MiB (80%)");
      if (voice) expect(output.additionalContext).toContain("visual host notice only: do not speak it or treat it as a spoken grant");
    } else expect(note).toEqual({});
  } finally { created.mockRestore(); directories.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
