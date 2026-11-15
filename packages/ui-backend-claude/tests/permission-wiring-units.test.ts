/**
 * Direct tests for the units #2519 extracted from `createPermissionWiring`.
 * The whole-wiring behaviour stays pinned by characterization-permissions,
 * allowlist-enforcement, confirm-bash, confirm-archive and edited-approval.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@schlessera/brain-ui-sdk/server";

import {
  carryPerUseEdit,
  commandGateTools,
  canUseToolFor,
  enforcementHookFor,
  mutatingHookFor,
  createNativeFileGuards,
  createPermissionContext,
  createPermissionWiring,
  outsideEnforcedAllowlist,
  reusablePerUseDecision,
  type PermissionWiringOptions,
} from "../src/permission-hooks.js";
import { BRAIN_UPDATE_TOOL } from "../src/tool-policy.js";

function contextFor(overrides: { enforceAllowedTools?: boolean; allowedTools?: string[]; confirmPatterns?: RegExp[] } = {}) {
  const requests: PermissionRequest[] = [];
  const locks: string[] = [];
  const options: PermissionWiringOptions = {
    req: {
      prompt: "Count the suitors in the hall", signal: new AbortController().signal,
      enforceAllowedTools: overrides.enforceAllowedTools,
      bridge: { emit: () => {}, requestPermission: async (request: PermissionRequest) => { requests.push(request); return { behavior: "allow" }; } },
    } as never,
    allowedTools: overrides.allowedTools ?? ["Read"],
    confirmPatterns: overrides.confirmPatterns ?? [],
    brainPath: "/srv/odysseus-brain",
    turnLock: { acquireForTool: async (id: string) => { locks.push(id); return { ok: true }; }, releaseForTool() {} } as never,
    childEnv: {},
    log: () => {},
  };
  const { nativeRefusal } = createNativeFileGuards(options);
  return { ctx: createPermissionContext(options, nativeRefusal), requests, locks };
}

const hookCall = (tool_name: string, tool_input: Record<string, unknown> = {}) =>
  [{ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "oar-1" } as never, undefined, { signal: new AbortController().signal }] as const;

describe("the grant decision", () => {
  test("only an enforced turn's off-list tool is outside the enforced allowlist", () => {
    const allowed = new Set(["Read"]);
    expect(outsideEnforcedAllowlist(true, allowed, "Bash"), "GRANT_DECISION_ENFORCED_OFF_LIST").toBe(true);
    expect(outsideEnforcedAllowlist(true, allowed, "Read"), "GRANT_DECISION_ENFORCED_ON_LIST").toBe(false);
    expect(outsideEnforcedAllowlist(false, allowed, "Bash"), "GRANT_DECISION_UNENFORCED").toBe(false);
  });

  test("canUseTool tells the host a remembered grant cannot answer an off-list tool on an enforced turn", async () => {
    for (const [enforced, tool, expected] of [[true, "Glob", true], [true, "Read", false], [false, "Glob", false]] as const) {
      const { ctx, requests } = contextFor({ enforceAllowedTools: enforced });
      await canUseToolFor(ctx)(tool, { pattern: "ithaca/*.md" }, { toolUseID: "oar-1", signal: new AbortController().signal } as never);
      expect(requests.map(request => request.outsideEnforcedAllowlist ?? false), `REMEMBERED_GRANT_${enforced}_${tool}`).toEqual([expected]);
    }
  });

  test("the enforcement hook asks for an off-list tool and leaves an allowlisted one alone", async () => {
    const { ctx } = contextFor({ enforceAllowedTools: true });
    const hook = enforcementHookFor(ctx);
    expect(await hook(...hookCall("Glob"))).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(await hook(...hookCall("Read"))).toEqual({ continue: true });
  });
});

describe("the allowlist decisions", () => {
  test("the confirmation gate always evaluates Bash and both brain_update names as allowed", () => {
    const gate = commandGateTools(["Read"]);
    expect([...gate]).toEqual(["Read", "Bash", BRAIN_UPDATE_TOOL, "mcp__brain__brain_update"]);
  });

  test("a per-use decision answers the tool grant only for an allowlisted tool", () => {
    const allow = { behavior: "allow" as const };
    expect(reusablePerUseDecision(allow, new Set(["Bash"]), "Bash")).toBe(allow);
    expect(reusablePerUseDecision(allow, new Set(["Read"]), "Bash")).toBeUndefined();
    expect(reusablePerUseDecision(undefined, new Set(["Bash"]), "Bash")).toBeUndefined();
  });

  test("a grant that kept a per-use edit applies the edited input", () => {
    const edited = { command: "ls ithaca" };
    const perUse = { behavior: "allow" as const, updatedInput: edited };
    expect(carryPerUseEdit({ behavior: "allow" }, perUse, edited)).toEqual({ behavior: "allow", updatedInput: edited });
    expect(carryPerUseEdit({ behavior: "allow" }, { behavior: "allow" }, edited)).toEqual({ behavior: "allow" });
    const denied = { behavior: "deny" as const, message: "Penelope declined." };
    expect(carryPerUseEdit(denied, perUse, edited)).toBe(denied);
  });
});

describe("the extracted callbacks", () => {
  test("the mutating hook raises a per-use card for a confirmed command before taking the lock", async () => {
    const { ctx, requests, locks } = contextFor({ allowedTools: ["Bash"], confirmPatterns: [/\brm\s+-rf\b/] });
    const output = await mutatingHookFor(ctx)(...hookCall("Bash", { command: "rm -rf loom" }));
    expect(output).toEqual({ continue: true });
    expect(requests.map(request => request.kind)).toEqual(["command"]);
    expect(locks).toEqual(["oar-1"]);
  });

  test("the mutating hook leaves an unconfirmed call to canUseTool and still serializes it", async () => {
    const { ctx, requests, locks } = contextFor({ allowedTools: ["Bash"], confirmPatterns: [/\brm\s+-rf\b/] });
    expect(await mutatingHookFor(ctx)(...hookCall("Bash", { command: "mkdir raft" }))).toEqual({ continue: true });
    expect(requests).toEqual([]);
    expect(locks).toEqual(["oar-1"]);
  });

  test("canUseTool takes the write lock only after the grant", async () => {
    const { ctx, requests, locks } = contextFor();
    const result = await canUseToolFor(ctx)("Bash", { command: "mkdir raft" }, { toolUseID: "oar-1", signal: new AbortController().signal } as never);
    expect(result).toEqual({ behavior: "allow" });
    expect(requests.map(request => request.kind)).toEqual(["tool"]);
    expect(locks).toEqual(["oar-1"]);
  });
});

describe("admissions, refusals and the collector's last check", () => {
  // Every deny this backend returns is its own denial before the call could
  // run, and refuses the call's id at the host's collector, so nothing later
  // under that id is admitted or let run. The collector discharges the call
  // on it only for the id's only admission, never allowed, so each admission
  // the runtime makes is reported (#3812).
  function wiring(signal: AbortSignal, unchecked?: string) {
    const refused: [string, boolean | undefined][] = [], allowed: string[] = [], released: string[] = [], admitted: string[] = [];
    const { canUseTool, hooks } = createPermissionWiring({
      req: { prompt: "Count the suitors in the hall", signal,
        bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }),
          inputSafety: { ready: async () => {}, begin: async () => {}, result: async () => {}, admitting: (id: string) => { admitted.push(id); },
            refused: async (id: string, denied?: boolean) => { refused.push([id, denied]); },
            allowed: async (id: string) => { if (id === unchecked) throw new Error("Safety operation was refused or not admitted; the call does not run"); allowed.push(id); } } } } as never,
      allowedTools: ["Read"], confirmPatterns: [], brainPath: "/srv/odysseus-brain",
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool(id: string) { released.push(id); } } as never, childEnv: {}, log: () => {},
    });
    const preToolUse = hooks!.PreToolUse!.find(group => !group.matcher)!.hooks[0]!;
    return { canUseTool: canUseTool!, preToolUse, hooks: hooks!, refused, allowed, released, admitted };
  }

  test("a call the backend denies is refused at the collector as its own denial", async () => {
    const stopped = new AbortController(); stopped.abort();
    const { canUseTool, preToolUse, refused } = wiring(stopped.signal);
    expect((await canUseTool("Glob", { pattern: "ithaca/*.md" }, { toolUseID: "oar-1", signal: stopped.signal } as never))?.behavior).toBe("deny");
    const [input, , options] = hookCall("Grep", { pattern: "suitors" });
    const output = await preToolUse({ ...(input as object), tool_use_id: "oar-2" } as never, "oar-2", options);
    expect((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(refused, "CLAUDE_DENY_REFUSES_THE_CALL").toEqual([["oar-1", true], ["oar-2", true]]);
  });

  test("a call the backend lets run is checked by the collector and never refused", async () => {
    const live = new AbortController();
    const { canUseTool, preToolUse, refused, allowed } = wiring(live.signal);
    expect((await canUseTool("Glob", { pattern: "ithaca/*.md" }, { toolUseID: "oar-1", signal: live.signal } as never))?.behavior).toBe("allow");
    await preToolUse(...hookCall("Read", { file_path: "/srv/odysseus-brain/notes/ithaca.md" }));
    expect(refused, "CLAUDE_ALLOW_LEAVES_THE_CALL_OWED").toEqual([]);
    // The callback's allow is the runtime's last gate, so the collector
    // checks it before the call runs (#3812).
    expect(allowed, "CLAUDE_CALLBACK_ALLOW_IS_CHECKED").toEqual(["oar-1"]);
  });

  test("a callback allow the collector's check refuses is denied instead", async () => {
    const live = new AbortController();
    const { canUseTool, refused, released } = wiring(live.signal, "oar-1");
    const answer = await canUseTool("Glob", { pattern: "ithaca/*.md" }, { toolUseID: "oar-1", signal: live.signal } as never);
    expect(answer, "CLAUDE_UNCHECKED_ALLOW_IS_DENIED").toMatchObject({ behavior: "deny", message: expect.stringContaining("does not run") });
    expect(refused, "CLAUDE_UNCHECKED_ALLOW_IS_REFUSED").toEqual([["oar-1", true]]);
    expect(released, "CLAUDE_UNCHECKED_ALLOW_RELEASES_ITS_LOCK").toContain("oar-1");
  });

  test("each admission the runtime makes is reported once, by whichever of its hooks starts first", async () => {
    const live = new AbortController();
    const { hooks, admitted } = wiring(live.signal);
    // A file write matches more than one PreToolUse hook; the runtime runs each once per admission.
    const matching = hooks.PreToolUse!.filter(group => !group.matcher || new RegExp(group.matcher).test("Write")).map(group => group.hooks[0]!);
    expect(matching.length, "CLAUDE_WRITE_PASSES_SEVERAL_HOOKS").toBeGreaterThan(1);
    const call = [{ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/srv/odysseus-brain/notes/raft.md", content: "Sail at dawn." }, tool_use_id: "oar-3" } as never,
      "oar-3", { signal: live.signal }] as const;
    await Promise.all(matching.map(hook => hook(...call)));
    expect(admitted, "CLAUDE_ONE_ADMISSION_IS_REPORTED_ONCE").toEqual(["oar-3"]);
    // A second admission under the id: its first hook reports it before any wait of its own.
    const second = matching[matching.length - 1]!(...call);
    expect(admitted, "CLAUDE_SECOND_ADMISSION_IS_REPORTED_AT_ONCE").toEqual(["oar-3", "oar-3"]);
    await Promise.all([second, ...matching.slice(0, -1).map(hook => hook(...call))]);
    expect(admitted, "CLAUDE_SECOND_ADMISSION_IS_REPORTED_ONCE").toEqual(["oar-3", "oar-3"]);
  });

  test("a reused id under another tool name is a new admission, reported by its first hook even when that hook never saw the id", async () => {
    const live = new AbortController();
    const { hooks, admitted } = wiring(live.signal);
    const common = hooks.PreToolUse!.find(group => !group.matcher)!.hooks[0]!;
    const mutating = hooks.PreToolUse!.find(group => group.matcher && new RegExp(group.matcher).test("Bash") && !/Agent/.test(group.matcher))!.hooks[0]!;
    const as = (tool_name: string, tool_input: Record<string, unknown>) => [{ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "oar-4" } as never, "oar-4", { signal: live.signal }] as const;
    // The runtime admits a search: only the common hook matches it.
    await common(...as("Grep", { pattern: "suitors" }));
    expect(admitted, "CLAUDE_SEARCH_ADMISSION_IS_REPORTED").toEqual(["oar-4"]);
    // A shell call reuses the id. Its mutating hook starts first and has never
    // seen the id, yet the admission is reported before that hook decides.
    const shell = mutating(...as("Bash", { command: "echo rafts", run_in_background: true }));
    expect(admitted, "CLAUDE_REUSED_ID_UNDER_ANOTHER_TOOL_IS_A_NEW_ADMISSION").toEqual(["oar-4", "oar-4"]);
    await shell; await common(...as("Bash", { command: "echo rafts", run_in_background: true }));
    expect(admitted, "CLAUDE_REUSED_ID_ADMISSION_IS_REPORTED_ONCE").toEqual(["oar-4", "oar-4"]);
  });
});
