import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { prepareWorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeSdkTurn } from "../src/sdk-options";
import { identicalSystemPromptOptions } from "../../../tests/helpers/provider-history";
import { DEFAULT_ALLOWED_TOOLS } from "../src/tool-policy";

/** The owned new-tail context the next turn sends carries the host's recorded taint (G6). */
async function contextText(taint: { eventId: number; source: string } | null) {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-taint-note-")), root = join(scratch, "brain"), previous = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(root);
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
  try {
    const bridge = { emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "Odysseus declines." }) } as unknown as BackendBridge;
    const sandbox = { ...prepareWorkerSandbox(root, { home: join(scratch, "home") }),
      commandPolicy: { hash: null, deny: [], confirm: [], outwardAllow: [], taint: () => taint } };
    const turn = createClaudeSdkTurn({ backend: { brainPath: root }, req: { prompt: "Odysseus plans the next leg.", signal: new AbortController().signal, bridge,
      sessionId: "voyage", workerSandbox: sandbox },
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never, abortController: new AbortController(), allowedTools: DEFAULT_ALLOWED_TOOLS,
      confirmPatterns: [], turnLock: { acquire: () => {}, release: () => {} } as never, log: () => {} });
    for await (const message of turn.prompt as AsyncIterable<{ message: unknown }>) return JSON.stringify(message.message);
    throw new Error("No owned prompt");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("Claude's capabilities note states the session taint and that tainted egress is unenforced off the proxy", async () => {
  const tainted = await contextText({ eventId: 7, source: "web_fetch" });
  expect(tainted, "CLAUDE_NOTE_STATES_TAINT").toContain("This session is tainted (first recorded source: web_fetch).");
  expect(tainted, "CLAUDE_NOTE_UNPROXIED_TAINT_EGRESS").toContain("Tainted egress is not enforced for this turn");
  expect(await contextText(null)).not.toContain("This session is tainted");
});

// The installed local CLI can replay its original system bytes even when the
// caller changes its SDK option. Exercise the real option assembly without
// that replay, so an offline mutation can prove the upgrade guard itself.
test("Claude retained safety wording stays identical in SDK options across an upgrade", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-safety-options-")), root = join(scratch, "brain");
  mkdirSync(root);
  const captured: unknown[] = [];
  try {
    for (let index = 0; index < 3; index++) {
      const controller = new AbortController();
      const turn = createClaudeSdkTurn({ backend: { brainPath: root,
        systemPromptAppend: index === 0 ? "Legacy safety policy: this session stays restricted." : "Reviewed safety policy: finalized individual verdicts may restore normal." },
        req: { prompt: "Odysseus plans the next leg.", sessionId: "voyage", signal: controller.signal,
          bridge: { emit() {}, requestPermission: async () => ({ behavior: "deny", message: "Odysseus declines." }) },
          workerSandbox: { ...prepareWorkerSandbox(root, { home: join(scratch, "home") }),
            commandPolicy: { hash: null, deny: [], confirm: [], outwardAllow: [], taint: () => index === 2 ? null : { eventId: 7, source: "web_fetch" } } } },
        profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never, abortController: controller,
        allowedTools: DEFAULT_ALLOWED_TOOLS, confirmPatterns: [], turnLock: { acquire() {}, release() {} } as never, log() {} });
      try { captured.push(turn.options.systemPrompt); } finally { await turn.finishWorker(); }
    }
    expect(JSON.stringify(captured[0]), "SAFETY_SDK_OPTIONS_RETAIN_LEGACY_WORDING").toContain("Legacy safety policy: this session stays restricted.");
    identicalSystemPromptOptions(captured, "SAFETY_UPGRADE_RETAINS_SDK_OPTIONS");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
