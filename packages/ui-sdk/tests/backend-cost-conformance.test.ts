import { describe, expect, test } from "bun:test";
import type { ServerResultMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { runBackendContract, type BackendContractHarness } from "@schlessera/brain-ui-sdk/testing";

const lifecycle = "turn lifecycle: session_info first, deltas, terminal result, then resolve";

function costLifecycle(costReporting: boolean, cost: { value: unknown } | undefined) {
  let result: ServerResultMessage | undefined;
  const unused = (): never => { throw new Error("This regression executes only the published lifecycle case."); };
  const harness: BackendContractHarness = {
    name: "scripted cost",
    permission: unused,
    hanging: unused,
    failing: unused,
    unknownProfileId: "unknown",
    scripted(script): AgentBackend {
      return {
        id: "fixture",
        capabilities: { resume: false, permissions: false, thinking: false, attachments: false, askUser: false, costReporting, concurrentSessions: false, followUp: false },
        listProfiles: () => [], listSessions: async () => [], getHistory: async () => [],
        async startTurn({ bridge }) {
          bridge.emit({ type: "session_info", sessionId: script.sessionId, isNew: true });
          for (const text of script.textDeltas) bridge.emit({ type: "text_delta", sessionId: script.sessionId, text });
          result = {
            type: "result", sessionId: script.sessionId, outcome: "success",
            durationMs: 1, numTurns: 1, isError: false,
            // Deliberately malformed values test the suite's runtime assertions.
            ...(cost === undefined ? {} : { costUsd: cost.value as number }),
          };
          expect(Object.hasOwn(result, "costUsd")).toBe(cost !== undefined);
          if (cost !== undefined) expect(result.costUsd as unknown).toBe(cost.value);
          bridge.emit(result);
        },
      };
    },
  };
  const cases = new Map<string, () => void | Promise<void>>();
  runBackendContract(harness, { describe: (_name, fn) => fn(), test: (name, fn) => { cases.set(name, fn); }, expect });
  const check = cases.get(lifecycle);
  if (!check) throw new Error(`Published suite did not register ${lifecycle}`);
  return { run: () => Promise.resolve().then(check), result: () => result };
}

for (const costReporting of [false, true]) {
  describe(`published lifecycle cost assertions (costReporting: ${costReporting})`, () => {
    test("accepts unknown cost without inventing a zero", async () => {
      const fixture = costLifecycle(costReporting, undefined);
      await fixture.run();
      expect(fixture.result()).toBeDefined();
      expect(Object.hasOwn(fixture.result()!, "costUsd")).toBe(false);
    });

    for (const value of [0, 0.125]) {
      test(`accepts a known nonnegative cost of ${value}`, async () => {
        const fixture = costLifecycle(costReporting, { value });
        await fixture.run();
        expect(fixture.result()!.costUsd).toBe(value);
      });
    }

    for (const [label, value] of [["string", "0.125"], ["null", null]] as const) {
      test(`rejects a present ${label} cost on the numeric assertion`, async () => {
        const fixture = costLifecycle(costReporting, { value });
        await expect(fixture.run()).rejects.toThrow('Expected: "number"');
        expect(Object.hasOwn(fixture.result()!, "costUsd")).toBe(true);
      });
    }

    test("rejects a negative cost on the nonnegative assertion", async () => {
      const fixture = costLifecycle(costReporting, { value: -0.125 });
      await expect(fixture.run()).rejects.toThrow("Expected: >= 0");
      expect(fixture.result()!.costUsd).toBe(-0.125);
    });
  });
}
