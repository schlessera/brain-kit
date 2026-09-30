import { describe, expect, test } from "bun:test";

import { assertTurnPosture, BackendRequestError, type AgentBackend } from "../src/server/backend";
import { defineBackendModule, type BackendModule } from "../src/server/backend-module";
import {
  runBackendContract, runBackendModuleContract,
  type BackendContractHarness, type BackendModuleContractHarness, type PermissionScenario,
} from "../src/testing";

type Fault = "none" | "ignore-deny" | "shortcut" | "park" | "reject" | "late-reject";

/** Deliberate bad implementations exercise the published assertions themselves. */
function fakeHarness(fault: Fault): BackendContractHarness {
  return {
    name: fault,
    permission(scenario: PermissionScenario) {
      let starts = 0;
      let attempts = 0;
      let effects = 0;
      const toolName = scenario === "command" ? "shell" : "write";
      const backend: AgentBackend = {
        id: "example",
        capabilities: { resume: false, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: false, followUp: false },
        listProfiles: () => [], listSessions: async () => [], getHistory: async () => [],
        async startTurn(req) {
          assertTurnPosture(req);
          if (req.enforceAllowedTools && fault === "reject") throw new BackendRequestError("Unsupported restriction.");
          starts++;
          if (req.enforceAllowedTools && fault === "late-reject") throw new BackendRequestError("Too late.");
          attempts++;
          let denied = false;
          let message = "";
          if (req.noGrantSurface && fault !== "park") {
            denied = true;
            message = `Permission denied for ${toolName}.`;
            req.bridge.activity?.({ kind: "permission_denied", toolUseId: "fixture-tool", requestKind: scenario === "command" ? "command" : "tool", reason: message });
          } else if (!(scenario === "shortcut" && fault === "shortcut")) {
            const decision = await req.bridge.requestPermission({
              toolUseId: "fixture-tool", toolName, input: { fixture: "nonempty" },
              kind: scenario === "command" ? "command" : "tool",
              outsideEnforcedAllowlist: req.enforceAllowedTools && scenario !== "command",
            });
            denied = decision.behavior === "deny";
            if (decision.behavior === "deny") message = decision.message;
          }
          // The actual fake tool body has an observable effect. The buggy
          // implementation still emits a denial, but runs that body anyway.
          if (!denied || fault === "ignore-deny") effects++;
          req.bridge.emit({ type: "tool_result", toolUseId: "fixture-tool", output: message || "ran", isError: denied });
        },
      };
      return { backend, toolName, toolUseId: "fixture-tool", starts: () => starts, attempts: () => attempts, effects: () => effects };
    },
    scripted: () => { throw new Error("not used by this test"); },
    hanging: () => { throw new Error("not used by this test"); },
    failing: () => { throw new Error("not used by this test"); },
    unknownProfileId: "unknown",
  };
}

function registered(harness: BackendContractHarness) {
  const cases = new Map<string, () => void | Promise<void>>();
  runBackendContract(harness, { describe: (_name, fn) => fn(), test: (name, fn) => { cases.set(name, fn); }, expect });
  return (name: string) => {
    const fn = cases.get(name);
    if (!fn) throw new Error(`Missing contract case: ${name}`);
    return Promise.resolve().then(fn);
  };
}

describe("published backend conformance assertions", () => {
  test("a backend that ignores a deny fails on the tool body's effect", async () => {
    const run = registered(fakeHarness("ignore-deny"));
    await expect(run("permissions: a denied mutation does not execute and returns the denial")).rejects.toThrow(/Expected: 0/);
  });

  test("a runtime shortcut past the enforced decision fails on the effect", async () => {
    const run = registered(fakeHarness("shortcut"));
    await expect(run("enforceAllowedTools: shortcut cannot bypass a denied decision")).rejects.toThrow(/Expected: 0/);
  });

  test("a no-grant backend that parks on an unanswered card fails promptly", async () => {
    const run = registered(fakeHarness("park"));
    await expect(run("noGrantSurface: mutation denies promptly without an unanswered card")).rejects.toThrow(/parked instead of settling/);
  });

  test("unsupported restrictions may reject only before runtime acquisition", async () => {
    const name = "enforceAllowedTools: mutation cannot bypass a denied decision";
    await registered(fakeHarness("reject"))(name);
    await expect(registered(fakeHarness("late-reject"))(name)).rejects.toThrow(/Expected: 0/);
  });

  test("safe rejection of no-grant restrictions does not start the runtime", async () => {
    await registered(fakeHarness("reject"))("noGrantSurface: command denies promptly without an unanswered card");
  });

  test("a conforming backend passes each mandatory permission/posture case", async () => {
    const cases = new Map<string, () => void | Promise<void>>();
    runBackendContract(fakeHarness("none"), { describe: (_name, fn) => fn(), test: (name, fn) => { cases.set(name, fn); }, expect });
    for (const [name, fn] of cases) {
      if (/^(permissions:|enforceAllowedTools:|noGrantSurface)/.test(name)) await fn();
    }
  });
});

test("a descriptor that rejects a valid profile fails the shared descriptor case", async () => {
  const module: BackendModule = defineBackendModule({
    id: "example", settingsHooks: {},
    profileSchema: { source: "EXAMPLE_PROFILES", parse: () => ({ ok: false, errors: [{ code: "invalid_entry", message: "incorrectly rejected" }] }) },
    resolveFromEnv: () => { throw new Error("must not resolve rejected profiles"); },
  });
  const harness: BackendModuleContractHarness = {
    name: "bad descriptor", module, validProfilesJson: '[{"id":"valid","label":"Valid"}]', profileIds: ["valid"],
    context: () => ({ brainPath: "/fixture", config: {}, settings: {}, confirmBashPatterns: null }),
  };
  const cases = new Map<string, () => void | Promise<void>>();
  runBackendModuleContract(harness, { describe: (_name, fn) => fn(), test: (name, fn) => { cases.set(name, fn); }, expect });
  const check = cases.get("a valid nonempty profile roster survives parsing and resolution")!;
  await expect(Promise.resolve().then(check)).rejects.toThrow(/Expected: true/);
});
