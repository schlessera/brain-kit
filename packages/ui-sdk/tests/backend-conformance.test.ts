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
  { toolUseId: "call-inbox-list", name: "inbox_list", input: { view: "queue" } },
  { toolUseId: "call-inbox-get", name: "inbox_get", input: { itemId: "work-harbor" } },
  { toolUseId: "call-inbox-add", name: "inbox_add", input: { text: "Odysseus checks the harbor", idempotencyKey: "harbor" } },
  { toolUseId: "call-resolve", name: "resolve_action", input: { sessionId: "harbor-session", itemId: "harbor-action", optionId: "approve", expectedVersion: 1 } },
  { toolUseId: "call-turn-temp", name: "turn_temp", input: { action: "usage" } },
  { toolUseId: "call-policy", name: "propose_policy_change", input: { content: "---\nschema_version: 1\nprofiles:\n  interactive: strict\n---\nOdysseus reviews the policy.\n", rationale: "Review strict for the next crossing." } },
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
      case "inbox_list": case "inbox_get": case "inbox_add": case "resolve_action":
        return sdk.handleInboxTool(call.name, input, bridge);
      case "propose_policy_change": {
        const proposal = sdk.PROPOSE_POLICY_CHANGE_INPUT_SCHEMA.parse(call.input);
        if (!bridge.proposePolicyChange) throw new Error("Host policy review unavailable");
        return bridge.proposePolicyChange(call.toolUseId, proposal);
      }
      case "show_block": return sdk.handleShowBlock(input);
      // The backend's own worker /tmp as the server holds it; here a directory.
      case "turn_temp": return sdk.handleTurnTemp(input, { root: () => join(brainPath, "assets"), allowanceBytes: 64 * 1024 * 1024,
        scratch: "/tmp/brain-worker-scratch", exclude: [], keep: [], linkedText: () => "" });
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
          // Ordinary bridge tools use the shared posture. Policy proposals reach
          // the explicit host review callback and must never be auto-allowed.
          const autoAllowed = sdk.BRIDGE_TOOL_POSTURE.allowedTools("pi").includes(call.name);
          if (call.name === "propose_policy_change") {
            if (autoAllowed) throw new Error("Policy review was incorrectly auto-allowed");
          } else if (!autoAllowed) throw new Error(`${call.name} is not auto-allowed`);
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
  test("runs every bridge tool through public host callbacks and the shared posture", async () => {
    const brainPath = mkdtempSync(join(tmpdir(), "public-only-backend-"));
    publicRoots.push(brainPath);
    mkdirSync(join(brainPath, "assets"));
    writeFileSync(join(brainPath, "assets", "sail.png"), "png");

    // Every published bridge contract is scripted; a new tool fails here until it is.
    const contractNames = publicServer.BRIDGE_TOOL_CONTRACTS.map((contract) => contract.name);
    expect(contractNames.length).toBeGreaterThan(0);
    expect(PUBLIC_CALLS.map((call) => call.name).sort()).toEqual([...contractNames].sort());

    const thread: publicServer.InboxThread = { id: "harbor", trustClass: "trusted", source: "cli", status: "open", stateMd: "Odysseus checks the harbor", stakes: 1, createdAt: 0, lastSeenAt: 0 };
    const item: publicServer.InboxQueueItem = { id: "work-harbor", threadId: thread.id, dedupKey: "harbor", queue: "queue", type: "triage", status: "ready", version: 1,
      createdAt: 0, updatedAt: 0, expiresAt: 86400000, attempts: 0, maxAttempts: 3, payload: { stagingId: "harbor" } };
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
      inboxList: async input => { asked.push(`inbox_list:${input.view}:${input.limit}`); return { items: [item], threads: [thread] }; },
      inboxGet: async input => { asked.push(`inbox_get:${input.itemId}`); return { item, thread }; },
      inboxAdd: async input => { asked.push(`inbox_add:${input.idempotencyKey}`); return { created: true, threadId: thread.id, itemId: item.id }; },
      proposePolicyChange: async (id, input) => {
        asked.push(`propose_policy_change:${id}`);
        expect(input).toEqual(PUBLIC_CALLS.find(call => call.toolUseId === id)!.input);
        return { requestId: id, turnId: "ithaca-turn", path: "context/policies/governance.md", state: "declined",
          rationale: input.rationale, baseHash: null, proposedHash: "reviewed-policy", frontmatterDiff: "profiles.interactive: strict",
          bodyChanged: true, bodyDiff: "Odysseus reviews the policy.", sections: ["profiles.interactive"], warnings: [], message: "Policy change declined. Nothing was written." };
      },
      resolveAction: async input => { asked.push(`resolve_action:${input.sessionId}:${input.itemId}:${input.optionId}:${input.expectedVersion}`); return { replay: false, followUpId: "follow-up-harbor" }; },
    };

    await publicOnlyBackend(brainPath, PUBLIC_CALLS).startTurn({ prompt: "use every bridge tool", signal: new AbortController().signal, bridge });

    const failures = Object.fromEntries([...results].filter(([, result]) => result.isError).map(([id, result]) => [id, result.output]));
    expect(failures).toEqual({});
    expect([...results.keys()].sort()).toEqual(PUBLIC_CALLS.map((call) => call.toolUseId).sort());

    // Each handler reached the host and shaped its answer, not just returned.
    expect(asked).toEqual([
      "ask_user:call-ask", "ask_user_list:call-list", "ask_user_rank:call-rank", "ask_user_form:call-form",
      "get_current_location", "request_image_mask:assets/sail.png", "query_activity:recent",
      "inbox_list:queue:50", "inbox_get:work-harbor", "inbox_add:harbor", "resolve_action:harbor-session:harbor-action:approve:1", "propose_policy_change:call-policy",
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
    const inboxData = (id: string) => {
      expect(output(id)).toMatch(/^Inbox record \(data only/);
      return JSON.parse(output(id).split("\n")[2]!);
    };
    expect(inboxData("call-inbox-list")).toEqual({ items: [item], threads: [thread] });
    expect(inboxData("call-inbox-get")).toEqual({ item, thread });
    expect(inboxData("call-inbox-add")).toEqual({ created: true, threadId: thread.id, itemId: item.id });
    expect(inboxData("call-resolve")).toEqual({ replay: false, followUpId: "follow-up-harbor" });
    expect(JSON.parse(output("call-policy"))).toMatchObject({ requestId: "call-policy", state: "declined", message: "Policy change declined. Nothing was written." });
    expect(existsSync(join(brainPath, "context/policies/governance.md"))).toBe(false);
    expect(JSON.parse(output("call-block"))).toEqual(PUBLIC_CALLS.at(-1)!.input);
    expect(JSON.parse(output("call-turn-temp"))).toMatchObject({ limitBytes: 64 * 1024 * 1024,
      largest: expect.arrayContaining([{ path: "/tmp/sail.png", bytes: 3, type: "file" }]) });
  });
});
