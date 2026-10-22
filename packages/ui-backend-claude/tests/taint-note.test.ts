import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { prepareWorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeSdkTurn } from "../src/sdk-options";
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
