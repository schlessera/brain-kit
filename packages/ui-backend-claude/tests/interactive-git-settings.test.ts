import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
for (const billing of ["api", "subscription"] as const) test(`${billing} interactive options suppress preset git context`, async () => {
  const brainPath = mkdtempSync(join(tmpdir(), "interactive-git-settings-"));
  const turn = createClaudeSdkTurn({
    backend: { brainPath }, req: { prompt: "Odysseus plans the voyage.", bridge: {} } as never,
    profile: { id: "fixture", label: "Fixture", billing, requiredEnvKeys: [], buildEnv: () => ({}) },
    abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
    turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
  });
  try {
    expect(turn.options.settings, "BOTH_BILLING_MODES_DISABLE_GIT").toMatchObject({ includeGitInstructions: false });
    if (billing === "subscription") expect(turn.options.settings).toMatchObject({ apiKeyHelper: "", env: { ANTHROPIC_API_KEY: "" } });
  } finally { await turn.finishWorker(); rmSync(brainPath, { recursive: true, force: true }); }
});
