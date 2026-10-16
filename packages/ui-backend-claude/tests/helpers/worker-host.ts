/** Mock only the host probe for hand-driven SDK streams; native proof never imports this. */
import { afterEach, beforeEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as context from "../../src/prompt-context.js";
import { sessionPromptContext } from "@schlessera/brain-ui-sdk/internal";
import { workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
export function mockWorkerHostForSdkStream() {
  let probe: ReturnType<typeof spyOn>;
  let root: string;
  let prompt: ReturnType<typeof spyOn>, acknowledgement: ReturnType<typeof spyOn>;
  beforeEach(() => {
    probe = spyOn(workerHostBoundary, "probe").mockReturnValue({ ok: true });
    root = mkdtempSync(join(tmpdir(), "claude-sdk-context-"));
    const brain = join(root, "ithaca"); mkdirSync(brain);
    // Hand-driven SDK streams have no native transcript or real /brain directory.
    // Keep their newly persistent host context in this test's own storage.
    prompt = spyOn(context, "claudePromptContext").mockImplementation((_brain, id) => sessionPromptContext(join(root, "host"), brain, id));
    acknowledgement = spyOn(context, "acknowledgeClaudeContext").mockImplementation(() => {});
  });
  afterEach(() => {
    prompt.mockRestore(); acknowledgement.mockRestore(); probe.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });
}
