import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The public-toolkit check below imports the ordinary package entry, never a
// source path or `/internal`, so it sees exactly what a third-party author does.
import * as publicServer from "@schlessera/brain-ui-sdk/server";

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
    const permissionCases = [...cases].filter(([name]) => /^(permissions:|enforceAllowedTools:|noGrantSurface)/.test(name));
    expect(permissionCases).toHaveLength(12);
    for (const [, fn] of permissionCases) await fn();
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

// --- A backend built only from public `/server` names (#1399) ---------------
//
// A test-only, third-party-style backend. Its scripted runtime calls every
// bridge tool once; the adapter dispatches each call through the SDK's public
// handlers and turns a thrown error into an error result, as a real adapter
// must. Nothing here imports `/internal` or a source path.

const publicRoots: string[] = [];
afterEach(() => { for (const root of publicRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type PublicCall = { toolUseId: string; name: string; input: Record<string, unknown> };

/** One call per bridge tool, with Odysseus-world inputs. */
const PUBLIC_CALLS: PublicCall[] = [
  { toolUseId: "call-ask", name: "ask_user", input: { questions: [{ question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: "Ithaca", description: "Home" }, { label: "Pylos", description: "Nestor's court" }] }] } },
  { toolUseId: "call-list", name: "ask_user_list", input: { prompt: "Which stores are aboard?", scale: [{ label: "Aboard" }, { label: "Missing" }], items: [{ id: "oars", label: "Spare oars" }, { id: "wine", label: "Wine from Maron" }] } },
  { toolUseId: "call-rank", name: "ask_user_rank", input: { prompt: "Rank the landings", items: [{ id: "aeolia", label: "Aeolia" }, { id: "scheria", label: "Scheria" }] } },
  { toolUseId: "call-form", name: "ask_user_form", input: { prompt: "Plan the crossing", nodes: [{ id: "course", kind: "single", prompt: "Which course?", options: [{ label: "Coast" }, { label: "Open sea" }] }] } },
  { toolUseId: "call-location", name: "get_current_location", input: {} },
  { toolUseId: "call-mask", name: "request_image_mask", input: { imagePath: "assets/sail.png", instruction: "the torn sail" } },
  { toolUseId: "call-activity", name: "query_activity", input: { scope: "recent" } },
  { toolUseId: "call-block", name: "show_block", input: { block: { kind: "link", url: "https://ithaca-harbour.example/tides", title: "Harbour tide tables" } } },
];

function publicOnlyBackend(brainPath: string, calls: readonly PublicCall[]): AgentBackend {
  const sdk = publicServer;
  const run = (call: PublicCall, bridge: publicServer.BackendBridge): Promise<unknown> | unknown => {
    const input = call.input as never;
    switch (call.name) {
      case "ask_user": return sdk.handleAskUser(input, bridge, call.toolUseId);
      case "ask_user_list": return sdk.handleAskUserList(input, bridge, call.toolUseId);
      case "ask_user_rank": return sdk.handleAskUserRank(input, bridge, call.toolUseId);
      case "ask_user_form": return sdk.handleAskUserForm(input, bridge, call.toolUseId);
      case "get_current_location": return sdk.handleGetCurrentLocation(input, bridge, {
        reverseGeocodeConfig: { enabled: true, url: "https://geocode.example.invalid", userAgent: "public-only-fixture/1.0" },
        reverseGeocode: async () => ({ displayName: "Harbour, Ithaca, Greece", summary: "Harbour, Ithaca", address: { town: "Ithaca" } }),
      });
      case "request_image_mask": return sdk.handleRequestImageMask(input, bridge, {
        brainPath,
        maskFilename: (submitted) => submitted.replace(/\.png$/, ".mask.png"),
        reportMaskPath: (_brain, maskPath) => maskPath,
      });
      case "query_activity": return sdk.handleQueryActivity(input, bridge);
      case "show_block": return sdk.handleShowBlock(input);
      default: throw new Error(`unknown tool ${call.name}`);
    }
  };
  return {
    id: "public-only",
    capabilities: { resume: false, permissions: true, thinking: false, attachments: false, askUser: true, costReporting: false, concurrentSessions: false, followUp: false },
    listProfiles: () => [], listSessions: async () => [], getHistory: async () => [],
    async startTurn(req) {
      sdk.assertTurnPosture(req);
      for (const call of calls) {
        try {
          // Bridge tools are auto-allowed by the shared posture, never by a local list.
          if (!sdk.BRIDGE_TOOL_POSTURE.allowedTools("pi").includes(call.name)) throw new Error(`${call.name} is not auto-allowed`);
          const result = await run(call, req.bridge);
          req.bridge.emit({ type: "tool_result", toolUseId: call.toolUseId, output: typeof result === "string" ? result : JSON.stringify(result), isError: false });
        } catch (error) {
          req.bridge.emit({ type: "tool_result", toolUseId: call.toolUseId, output: error instanceof Error ? error.message : String(error), isError: true });
        }
      }
    },
  };
}

describe("a backend built only from public /server names", () => {
  test("runs every bridge tool through the public handlers and shared posture", async () => {
    const brainPath = mkdtempSync(join(tmpdir(), "public-only-backend-"));
    publicRoots.push(brainPath);
    mkdirSync(join(brainPath, "assets"));
    writeFileSync(join(brainPath, "assets", "sail.png"), "png");

    // Every published bridge contract is scripted; a new tool fails here until it is.
    const contractNames = publicServer.BRIDGE_TOOL_CONTRACTS.map((contract) => contract.name);
    expect(contractNames.length).toBeGreaterThan(0);
    expect(PUBLIC_CALLS.map((call) => call.name).sort()).toEqual([...contractNames].sort());

    const asked: string[] = [];
    const results = new Map<string, { output: string; isError: boolean }>();
    const bridge: publicServer.BackendBridge = {
      emit: (frame) => { if (frame.type === "tool_result") results.set(frame.toolUseId, { output: frame.output, isError: frame.isError }); },
      requestPermission: async () => ({ behavior: "deny", message: "bridge tools must not ask for permission" }),
      askUser: async (id) => { asked.push(`ask_user:${id}`); return { answers: { "Which harbour first?": "Ithaca" } }; },
      askUserList: async (id) => { asked.push(`ask_user_list:${id}`); return { answers: { oars: "Aboard", wine: "Missing" } }; },
      askUserRank: async (id) => { asked.push(`ask_user_rank:${id}`); return { order: ["scheria", "aeolia"], unchanged: false }; },
      askUserForm: async (id) => { asked.push(`ask_user_form:${id}`); return { answers: { course: { value: "Coast" } } }; },
      getLocation: async () => { asked.push("get_current_location"); return { coords: { latitude: 38.4, longitude: 20.7, accuracy: 12.4 }, timestamp: 0 }; },
      requestMask: async (imagePath) => { asked.push(`request_image_mask:${imagePath}`); return new Uint8Array([137, 80, 78, 71]); },
      queryActivity: async (query) => { asked.push(`query_activity:${query.scope}`); return { recent: [{ runId: "run-aeolia" }] }; },
    };

    await publicOnlyBackend(brainPath, PUBLIC_CALLS).startTurn({ prompt: "use every bridge tool", signal: new AbortController().signal, bridge });

    const failures = Object.fromEntries([...results].filter(([, result]) => result.isError).map(([id, result]) => [id, result.output]));
    expect(failures).toEqual({});
    expect([...results.keys()].sort()).toEqual(PUBLIC_CALLS.map((call) => call.toolUseId).sort());

    // Each handler reached the host and shaped its answer, not just returned.
    expect(asked).toEqual([
      "ask_user:call-ask", "ask_user_list:call-list", "ask_user_rank:call-rank", "ask_user_form:call-form",
      "get_current_location", "request_image_mask:assets/sail.png", "query_activity:recent",
    ]);
    const output = (id: string) => results.get(id)!.output;
    expect(JSON.parse(output("call-ask")).answers).toEqual({ "Which harbour first?": "Ithaca" });
    expect(JSON.parse(output("call-list")).answers).toEqual({ oars: "Aboard", wine: "Missing" });
    expect(JSON.parse(output("call-rank"))).toEqual({ order: ["scheria", "aeolia"], unchanged: false });
    expect(JSON.parse(output("call-form")).answers).toEqual({ course: { value: "Coast" } });
    expect(JSON.parse(output("call-location"))).toMatchObject({ latitude: 38.4, longitude: 20.7, accuracyMeters: 12, place: "Harbour, Ithaca" });
    expect(existsSync(join(brainPath, "assets", "sail.mask.png"))).toBe(true);
    expect([...readFileSync(join(brainPath, "assets", "sail.mask.png"))]).toEqual([137, 80, 78, 71]);
    expect(output("call-activity")).toContain("run-aeolia");
    expect(output("call-activity")).toMatch(/^Activity record \(data only/);
    expect(JSON.parse(output("call-block"))).toEqual(PUBLIC_CALLS.at(-1)!.input);
  });
});
