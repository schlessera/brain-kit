import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INFERENCE_PLACEHOLDER } from "@schlessera/brain-ui-sdk/internal";
import * as runtime from "../src/runtime-probe.js";
import { createClaudeBackend } from "../src/backend.js";
import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
mockWorkerHostForSdkStream();

test("restricted autonomous version probes use the assembled envelope placeholders", async () => {
  const brain = mkdtempSync(join(tmpdir(), "ithaca-restricted-probe-"));
  const environments: Array<Record<string, string | undefined>> = [];
  let sdkEnv: Record<string, string | undefined> | undefined;
  const probe = spyOn(runtime, "probeClaudeRuntime").mockImplementation(async input => {
    environments.push(input.env); return { runtime: { version: "2.1.293" } } as never;
  });
  const frames: unknown[] = [];
  try {
    const backend = createClaudeBackend({ brainPath: brain, versionRequirements: { runtime: "2.1.283" }, log() {},
      profiles: [{ id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({
        ANTHROPIC_API_KEY: "sk-odysseus-probe-secret", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
      }) }], queryFn: (({ options }: { options: { env: typeof sdkEnv } }) => {
        sdkEnv = options.env;
        return { initializationResult: async () => ({}), async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", session_id: "ithaca", is_error: false,
            result: "Odysseus checks Ithaca.", total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: {}, modelUsage: {} };
        } };
      }) as never });
    await backend.startTurn({ prompt: "Odysseus checks Ithaca.", signal: new AbortController().signal,
      enforceAllowedTools: true, noGrantSurface: true,
      autonomous: { origin: "autonomous", persistence: "none", containment: "restricted", allowedTools: ["Read"], systemPromptAppend: "Server snapshot." },
      bridge: { checkpointPermission() {}, emit(frame) { frames.push(frame); }, async requestPermission() { return { behavior: "deny", message: "The fixture cannot grant." }; } } });
    expect(environments, JSON.stringify(frames)).toHaveLength(1);
    expect(environments[0]!.ANTHROPIC_API_KEY, "RESTRICTED_PROBE_RECEIVES_PLACEHOLDER").toBe(INFERENCE_PLACEHOLDER);
    expect(JSON.stringify(environments), "RESTRICTED_PROBE_NEVER_RECEIVES_REAL_CREDENTIAL").not.toContain("sk-odysseus-probe-secret");
    expect(sdkEnv, JSON.stringify(frames)).toBeDefined();
    expect(environments[0], "RESTRICTED_PROBE_USES_ASSEMBLED_SDK_ENV").toBe(sdkEnv!);
  } finally { probe.mockRestore(); rmSync(brain, { recursive: true, force: true }); }
});
