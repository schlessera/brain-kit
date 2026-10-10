// Configured profiles resolve through pi's builtin catalog (#194, #708).
// These checks are keyless catalog reads, not proof of account access.
import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createPiBackend } from "../src/backend";
import { createBrainAccess } from "../src/brain-access";
import { resolveModelSpec, toModel } from "../src/profiles";
import { createSessionResources } from "../src/session-resources";
import { createSessionRuntime } from "../src/native-session-runtime";
import { randomUUID } from "node:crypto";
import { WORKER_SCRATCH } from "@schlessera/brain-ui-sdk/internal";
import { toolLockFromKeyed } from "../src/tools";
import { makeEmptyBrain } from "./helpers";

describe("pi builtin catalog", () => {
  for (const vendor of ["openai", "openai-codex"] as const) {
    for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]) {
      test(`${vendor}/${model} resolves with upstream Responses metadata`, () => {
        const resolved = toModel({ vendor, model });
        expect(resolved?.id).toBe(model);
        expect(resolved?.provider).toBe(vendor);
        expect(resolved?.api).toBe(
          vendor === "openai" ? "openai-responses" : "openai-codex-responses"
        );
        expect(resolved?.reasoning).toBe(true);
        expect(resolved?.input).toEqual(["text", "image"]);
        expect(resolved?.cost.input).toBeGreaterThan(0);
        expect(resolved?.contextWindow).toBeGreaterThan(0);
        // Preserve the catalog object, including pricing, context limits and
        // provider compatibility flags; do not fabricate a sibling's entry.
        expect(resolved).toEqual(getBuiltinModel(vendor, model as never));
      });
    }

    test(`${vendor}/gpt-6.1-sol supports the configured reasoning levels`, () => {
      const model = toModel({ vendor, model: "gpt-6.1-sol" });
      expect(model).toBeDefined();
      expect(getSupportedThinkingLevels(model!)).toEqual([
        // Codex accepts "minimal" by mapping it to provider effort "low".
        ...(vendor === "openai-codex" ? ["minimal" as const] : []),
        "low", "medium", "high", "xhigh", "max",
      ]);
    });

    test(`${vendor} still resolves an older supported model`, () => {
      const model = toModel({ vendor, model: "gpt-5.6-sol" });
      expect(model?.id).toBe("gpt-5.6-sol");
      expect(model?.provider).toBe(vendor);
    });

    test(`${vendor} refuses an unknown model with an actionable error`, () => {
      expect(() => toModel({ vendor, model: "gpt-0-nonexistent" })).toThrow(
        `Unknown model "${vendor}/gpt-0-nonexistent" — not in pi's builtin catalog. ` +
          "Fix the profile's vendor/model or update the pi SDK."
      );
    });

    test(`${vendor}/gpt-6.1-sol constructs a real SDK session with the curated tools`, async () => {
      const brain = makeEmptyBrain();
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = `${brain.root}/agent`;
      try {
        const backend = {
          brainPath: brain.root,
          profiles: [{ id: "configured-sol", label: "Sol 6.1", vendor, model: "gpt-6.1-sol", thinkingLevel: "high" as const }],
          loadExtensions: false,
        };
        const caps = { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false };
        const resources = createSessionResources({
          backend,
          brain: createBrainAccess(brain.root),
          lock: toolLockFromKeyed(createKeyedLock()),
          allowedTools: new Set<string>(),
          confirmPatterns: [],
          loadExtensions: false,
        });
        // This catalog unit test constructs the worker-local SDK directly.
        // Ordinary-turn containment and tool transport are proven separately
        // by pi-worker-runtime's real namespace/inference harness.
        const runtime = createSessionRuntime({ backend, sessionDir: WORKER_SCRATCH, resources,
          sessionId: randomUUID(), observeManager: () => {}, modelRuntimeOptions: {} });
        // Construct only: no prompt, credential login, provider request or billing.
        const { session } = await runtime.newSession("configured-sol", { caps });
        try {
          const real = session as AgentSession;
          expect(real.model?.id).toBe("gpt-6.1-sol");
          expect(real.model?.provider).toBe(vendor);
          expect(real.model?.api).toBe(vendor === "openai" ? "openai-responses" : "openai-codex-responses");
          expect(real.thinkingLevel).toBe("high");
          const curatedNames = resources.buildToolkit(caps).tools.map((tool) => tool.name).sort();
          expect(curatedNames).toContain("brain_search");
          expect(real.getActiveToolNames().sort()).toEqual(curatedNames);
        } finally {
          session.dispose();
        }
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        brain.cleanup();
      }
    });
  }

  test("new profiles preserve the first configured default and effective effort", () => {
    const brain = makeEmptyBrain();
    try {
      const profiles = [
        { id: "existing", label: "Existing Sol", vendor: "openai-codex", model: "gpt-5.6-sol" },
        { id: "new-api", label: "Sol 6.1 API", vendor: "openai", model: "gpt-6.1-sol", thinkingLevel: "high" as const },
        { id: "new-subscription", label: "Sol 6.1 subscription", vendor: "openai-codex", model: "gpt-6.1-sol" },
      ];
      const options = { brainPath: brain.root, profiles };
      expect(profiles).toHaveLength(3);
      const backend = createPiBackend(options);
      expect(backend.listProfiles()).toEqual([
        { id: "existing", label: "Existing Sol", vendor: "openai-codex", thinkingLevel: "medium", supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
        { id: "new-api", label: "Sol 6.1 API", vendor: "openai", thinkingLevel: "high", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "new-subscription", label: "Sol 6.1 subscription", vendor: "openai-codex", thinkingLevel: "medium", supportedThinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
      ]);
      expect(toModel(resolveModelSpec(options))?.id).toBe("gpt-5.6-sol");
      expect(toModel(resolveModelSpec(options, "new-api"))?.id).toBe("gpt-6.1-sol");
      expect(resolveModelSpec(options, "new-api")?.thinkingLevel).toBe("high");
      // The SDK catalog update must not grow an unconfigured picker roster.
      expect(createPiBackend({ brainPath: brain.root }).listProfiles()).toEqual([]);
    } finally {
      brain.cleanup();
    }
  });
});
