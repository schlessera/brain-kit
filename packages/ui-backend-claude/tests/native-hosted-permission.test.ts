import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { createTurnLockBinding } from "../src/turn-lock.js";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

for (const profile of ["governed", "strict"] as const) for (const posture of [undefined, "voice"] as const) {
  test(`hosted ${profile} ${posture ?? "typed"} preserves native registration and enforces authority`, async () => {
    const brain = mkdtempSync(join(tmpdir(), "odysseus-native-permission-"));
    let cards = 0;
    const lock = createTurnLockBinding({ turn: { ended: false, pendingReleases: new Map() }, writeLock: createKeyedLock(), lockWaitMs: 1000, log: () => {} });
    const controller = new AbortController();
    const turn = createClaudeSdkTurn({ backend: { brainPath: brain },
      req: { prompt: "Return to Ithaca.", signal: controller.signal, posture,
        workerSandbox: { brain, profile, restricted: false, areas: [], scratchAliasesRemoved: [] },
        bridge: { emit: () => {}, requestPermission: async () => { cards++; return { behavior: "allow" }; }, applyBrain: async () => ({}) } } as never,
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
      abortController: controller, allowedTools: ["Read", "Write", "Edit", "NotebookEdit"], confirmPatterns: [], turnLock: lock, log: () => {} });
    try {
      for (const name of ["Write", "Edit", "NotebookEdit"]) {
        expect(turn.options.disallowedTools, "NATIVE_ROSTER_STABLE").not.toContain(name);
        if (profile === "governed" && posture !== "voice") expect(turn.options.allowedTools, "GOVERNED_NATIVE_AUTO_ALLOWED").toContain(name);
        else {
          const input = { file_path: join(brain, "voyage.md"), notebook_path: join(brain, "loom.ipynb"), content: "Ithaca" };
          const results = [];
          for (const group of turn.options.hooks!.PreToolUse!) {
            if (!group.matcher || new RegExp(group.matcher).test(name)) for (const hook of group.hooks) results.push(await hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: `toolu_${name}` } as never, undefined, { signal: controller.signal }));
          }
          expect(results.some(result => "hookSpecificOutput" in result && result.hookSpecificOutput?.hookEventName === "PreToolUse" && result.hookSpecificOutput.permissionDecision === "deny"), "NATIVE_CALL_TIME_DENIAL").toBe(true);
          expect(await turn.options.canUseTool!(name, input, { toolUseID: `toolu_${name}`, signal: controller.signal } as never)).toMatchObject({ behavior: "deny" });
        }
      }
      expect(cards, "NO_NATIVE_PERMISSION_CARD").toBe(0);
    } finally { await turn.finishWorker(); lock.close(); rmSync(brain, { recursive: true, force: true }); }
  });
}
