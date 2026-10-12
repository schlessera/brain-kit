import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createWorkerStartupView, prepareWorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createWorkerSpawn } from "../src/worker-spawn.js";

test("Claude records output staging admission refusal as worker_state_busy with Retry", () => {
  const root = mkdtempSync("/tmp/odysseus-claude-staging-");
  const brain = join(root, "brain"); mkdirSync(brain);
  const old = process.env.BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES;
  process.env.BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES = String(256 * 1024 ** 2);
  let view: ReturnType<typeof createWorkerStartupView> | undefined;
  try {
    view = createWorkerStartupView(brain);
    const sandbox = prepareWorkerSandbox(brain, { profile: "strict", areas: [], readPaths: [process.execPath] });
    const controller = new AbortController();
    const worker = createWorkerSpawn(brain, {}, controller.signal, undefined, sandbox);
    expect(() => worker.spawn({ command: process.execPath, args: ["-e", "console.log('Odysseus')"],
      env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude") }, signal: controller.signal })).toThrow("Retry");
    expect(worker.failure(), "CLAUDE_OUTPUT_STAGING_REFUSAL_CLASS").toMatchObject({ errorClass: "worker_state_busy" });
    expect(worker.failure()?.message).toContain("output-staging capacity");
    expect(worker.failure()?.message).toContain("Retry");
  } finally {
    view?.cleanup();
    if (old === undefined) delete process.env.BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES; else process.env.BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES = old;
    rmSync(root, { recursive: true, force: true });
  }
});
