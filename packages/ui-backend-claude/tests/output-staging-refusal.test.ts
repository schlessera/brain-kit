import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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


test("Claude publication refusal fails only its worker lifecycle", async () => {
  const root = mkdtempSync("/tmp/odysseus-claude-publication-");
  const brain = join(root, "brain"); mkdirSync(brain); mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
  const destination = join(brain, ".brain/scratch/shared.md"); writeFileSync(destination, "before");
  const controller = new AbortController();
  const sandbox = prepareWorkerSandbox(brain, { profile: "strict" });
  const spawner = createWorkerSpawn(brain, {}, controller.signal, undefined, sandbox);
  try {
    const child = spawner.spawn({ command: "/bin/sh", args: ["-c", 'printf staged > /tmp/brain-worker-areas/scratch/shared.md; IFS= read -r go'],
      env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude") }, signal: controller.signal });
    child.on("error", () => {});
    // The copy exists before the host publishes a newer authoritative edit.
    writeFileSync(destination, "Penelope's newer content");
    child.stdin.end("go\n");
    await expect(spawner.finish(), "CLAUDE_PUBLICATION_REFUSAL_HANDLED").rejects.toThrow("stale maintenance output");
    await Bun.sleep(10);
  } finally { controller.abort(); rmSync(root, { recursive: true, force: true }); }
});
