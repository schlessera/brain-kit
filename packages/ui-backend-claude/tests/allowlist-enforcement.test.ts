/**
 * A narrowed `allowedTools` is a boundary, not a suggestion (#124).
 *
 * Both PreToolUse input-rewrite hooks used to answer `permissionDecision:
 * "allow"`, which makes the runtime skip `canUseTool` entirely — so a tool the
 * turn's allowlist left out executed anyway, with no decision taken anywhere.
 * A turn that declares `enforceAllowedTools` withholds that grant while KEEPING
 * the rewrite, and the call falls through to the ordinary permission path.
 *
 * The runtime precedence modelled by `runToolCall` (./helpers/run-tool-call.ts)
 * is not invented: it was measured for #124 with a real `query()`, and is
 * re-measured against the runtime `MEASURED_RUNTIME` names by
 * scripts/measure-claude-runtime.ts, which shows that
 * (a) a hook's `allow` skips `canUseTool`, (b) a hook's `updatedInput` applies
 * with no decision attached, (c) `canUseTool` then receives the REWRITTEN
 * input, (d) the runtime approves some calls on its own before the callback —
 * `echo hi` runs with an EMPTY allowedTools — and (e) a hook's `ask` overrides
 * (d) and forces the callback while leaving (b) intact. Without (b) this fix
 * would have had to choose between the rewrite and the decision; without (e)
 * it would not hold at all. The matching hooks run in parallel on the
 * original input, and the rewrite that finishes last is the one that runs;
 * the first describe block below holds the helper to that (#231).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Options, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendBridge,
  PermissionDecision,
  PermissionRequest,
} from "@schlessera/brain-ui-sdk/server";
import { resetRtkProbe } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { runToolCall } from "./helpers/run-tool-call";

interface Harness {
  options: Options;
  requests: PermissionRequest[];
  logs: { level: string; message: string }[];
}

/**
 * Start one turn and capture the SDK options it built. The turn ends before
 * any hook is fired, which is deliberate: the hooks and `canUseTool` close
 * over per-turn state and that state is what is under test.
 */
async function startTurn(setup: {
  allowedTools: string[];
  enforceAllowedTools?: boolean;
  decision?: PermissionDecision;
}): Promise<Harness> {
  const requests: PermissionRequest[] = [];
  const logs: { level: string; message: string }[] = [];
  const bridge: BackendBridge = {
    emit: () => {},
    requestPermission: async (request) => {
      requests.push(request);
      return setup.decision ?? { behavior: "deny", message: "Not approved." };
    },
  };
  let captured: Options | undefined;
  const queryFn = ((params: { options?: Options }) => {
    captured = params.options!;
    const stream = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1", apiKeySource: "none" };
      yield {
        type: "result",
        subtype: "success",
        session_id: "s1",
        total_cost_usd: 0,
        duration_ms: 1,
        num_turns: 1,
      };
    })();
    // A subscription account, as a real CLI reports one, so the per-turn
    // billing check (#211) has nothing to warn about here.
    return Object.assign(stream, {
      initializationResult: async () => ({
        account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" },
      }),
    });
  }) as unknown as typeof query;
  const backend = createClaudeBackend({
    brainPath: "/brain",
    queryFn,
    allowedTools: setup.allowedTools,
    log: (level, message) => logs.push({ level, message }),
  });
  await backend.startTurn({
    prompt: "enforce the allowlist",
    signal: new AbortController().signal,
    bridge,
    ...(setup.enforceAllowedTools ? { enforceAllowedTools: true } : {}),
  });
  return { options: captured!, requests, logs };
}

/**
 * A stand-in rewrite oracle on PATH, which the real `rtkRewriteCommand` shells
 * out to. "declines" is the other half of rtk's contract and the case that
 * leaves the rtk hook silent — the one where only the enforcement hook stands
 * between the command and the runtime's own auto-approval.
 */
function withFakeRtk(behaviour: "rewrites" | "declines" = "rewrites"): () => void {
  const directory = mkdtempSync(join(tmpdir(), "brain-124-rtk-"));
  const binary = join(directory, "rtk");
  writeFileSync(
    binary,
    "#!/bin/sh\n" +
      'if [ "$1" = "--version" ]; then exit 0; fi\n' +
      (behaviour === "declines"
        ? "exit 0\n"
        : "printf '%s\\n' '{\"hookSpecificOutput\":{\"updatedInput\":{\"command\":\"rtk git status\"}}}'\n")
  );
  chmodSync(binary, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  resetRtkProbe();
  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    resetRtkProbe();
    rmSync(directory, { recursive: true, force: true });
  };
}

const WITHOUT_SHELL_OR_AGENT = ["Read", "Grep", "Glob"];
const WITH_SHELL_AND_AGENT = ["Read", "Grep", "Glob", "Bash", "Agent"];
const BACKGROUND_AGENT_CALL = { description: "fan out", prompt: "look", run_in_background: true };

/** A PreToolUse hook that records the input it was handed, then answers. */
function recordingHook(
  seen: Record<string, unknown>[],
  answer: Record<string, unknown>,
  delayMs = 0
): HookCallback {
  return async (hookInput) => {
    seen.push((hookInput as { tool_input: Record<string, unknown> }).tool_input);
    if (delayMs > 0) await Bun.sleep(delayMs);
    return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", ...answer } };
  };
}

function bashHooks(hooks: HookCallback[], allowedTools: string[] = ["Bash"]): Options {
  return { allowedTools, hooks: { PreToolUse: [{ matcher: "Bash", hooks }] } };
}

describe("the harness runs PreToolUse hooks the way the runtime does", () => {
  test("parallel rewrites each see the original input, and the one that finishes last runs", async () => {
    const slowSaw: Record<string, unknown>[] = [];
    const fastSaw: Record<string, unknown>[] = [];
    // Registered first, finishes second: registration order must not decide.
    const slow = recordingHook(slowSaw, { updatedInput: { command: "slow rewrite" } }, 25);
    const fast = recordingHook(fastSaw, { updatedInput: { command: "fast rewrite" } });

    const outcome = await runToolCall(
      bashHooks([slow, fast]),
      "Bash",
      { command: "git status" },
      "harness-race"
    );

    expect(slowSaw).toEqual([{ command: "git status" }]);
    expect(fastSaw).toEqual([{ command: "git status" }]);
    expect(outcome.executed).toBe(true);
    expect(outcome.input).toEqual({ command: "slow rewrite" });
  });

  test("a hook registered after one that answers allow still runs", async () => {
    const laterSaw: Record<string, unknown>[] = [];
    const outcome = await runToolCall(
      bashHooks([recordingHook([], { permissionDecision: "allow" }), recordingHook(laterSaw, {})], []),
      "Bash",
      { command: "git status" },
      "harness-allow-then-record"
    );

    expect(laterSaw).toEqual([{ command: "git status" }]);
    expect(outcome.executed).toBe(true);
    expect(outcome.decided).toBe(false);
  });

  test("a deny from a hook registered after an allow still blocks", async () => {
    const outcome = await runToolCall(
      bashHooks([
        recordingHook([], { permissionDecision: "allow" }),
        recordingHook([], { permissionDecision: "deny", permissionDecisionReason: "no" }),
      ]),
      "Bash",
      { command: "git status" },
      "harness-allow-then-deny"
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.message).toBe("no");
  });

  test("allow from one hook and ask from another is refused as unmeasured", async () => {
    await expect(
      runToolCall(
        bashHooks([
          recordingHook([], { permissionDecision: "allow" }),
          recordingHook([], { permissionDecision: "ask" }),
        ]),
        "Bash",
        { command: "git status" },
        "harness-allow-and-ask"
      )
    ).rejects.toThrow("unmeasured");
  });
});

describe("an enforced allowlist and the rtk rewrite", () => {
  let restorePath: (() => void) | null = null;
  afterEach(() => {
    restorePath?.();
    restorePath = null;
  });

  test("a rewritten command outside the enforced allowlist does not run on the hook's say-so", async () => {
    restorePath = withFakeRtk();
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL_OR_AGENT,
      enforceAllowedTools: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Bash",
      { command: "git status" },
      "bash-enforced"
    );

    // The command never runs: the hook no longer grants it, and the decision
    // that replaced the grant was a denial.
    expect(outcome.executed).toBe(false);
    expect(outcome.decided).toBe(true);
    // A decision was taken, and it was taken on the REWRITTEN command — the
    // rewrite is the point of the hook and it survives.
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.toolName).toBe("Bash");
    expect(harness.requests[0]!.input).toEqual({ command: "rtk git status" });
    expect(harness.requests[0]!.outsideEnforcedAllowlist).toBe(true);
    // The withheld shortcut leaves a record rather than silently doing nothing.
    expect(
      harness.logs.filter(
        (entry) => entry.level === "warn" && entry.message.includes("allowlist enforced")
      )
    ).toHaveLength(1);
  });

  test("the same command runs rewritten when Bash IS on the enforced allowlist", async () => {
    restorePath = withFakeRtk();
    const harness = await startTurn({
      allowedTools: WITH_SHELL_AND_AGENT,
      enforceAllowedTools: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Bash",
      { command: "git status" },
      "bash-allowed"
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.input).toEqual({ command: "rtk git status" });
    expect(harness.requests).toHaveLength(0);
    expect(harness.logs.filter((entry) => entry.level === "warn")).toHaveLength(0);
  });

  test("a turn that declares nothing keeps today's behaviour, allowlist or not", async () => {
    restorePath = withFakeRtk();
    const harness = await startTurn({ allowedTools: WITHOUT_SHELL_OR_AGENT });

    const outcome = await runToolCall(
      harness.options,
      "Bash",
      { command: "git status" },
      "bash-default"
    );

    // Unchanged: the rewrite hook grants, nothing is asked, the command runs.
    expect(outcome.executed).toBe(true);
    expect(outcome.decided).toBe(false);
    expect(outcome.input).toEqual({ command: "rtk git status" });
    expect(harness.requests).toHaveLength(0);
  });
});

describe("an enforced allowlist against the runtime's own auto-approval", () => {
  let restorePath: (() => void) | null = null;
  afterEach(() => {
    restorePath?.();
    restorePath = null;
  });

  test("a command the runtime would wave through is still decided", async () => {
    // rtk declines, so the rewrite hook is silent and there is no grant to
    // withhold. What must hold the line is the enforcement hook: the runtime
    // approves plenty of shell commands (`echo hi`) before the callback is
    // ever consulted, and an allow rule in the project settings does the same
    // for a whole tool.
    restorePath = withFakeRtk("declines");
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL_OR_AGENT,
      enforceAllowedTools: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Bash",
      { command: "echo hello" },
      "bash-auto",
      true // the runtime would have approved it on its own
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.decided).toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.outsideEnforcedAllowlist).toBe(true);
  });

  test("the same command runs unasked when the turn declares nothing", async () => {
    restorePath = withFakeRtk("declines");
    const harness = await startTurn({ allowedTools: WITHOUT_SHELL_OR_AGENT });

    const outcome = await runToolCall(
      harness.options,
      "Bash",
      { command: "echo hello" },
      "bash-auto-default",
      true
    );

    // Unchanged, and the reason the declaration has to exist at all.
    expect(outcome.executed).toBe(true);
    expect(outcome.decided).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  test("a tool ON the enforced allowlist is not pushed into a decision", async () => {
    restorePath = withFakeRtk("declines");
    const harness = await startTurn({
      allowedTools: WITH_SHELL_AND_AGENT,
      enforceAllowedTools: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Read",
      { file_path: "/brain/a.md" },
      "read-auto",
      true
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.decided).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });
});

describe("an enforced allowlist and the Agent foreground rewrite", () => {
  test("a backgrounded Agent call outside the enforced allowlist is not re-admitted", async () => {
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL_OR_AGENT,
      enforceAllowedTools: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Agent",
      { ...BACKGROUND_AGENT_CALL },
      "agent-enforced"
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.decided).toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.toolName).toBe("Agent");
    // Foregrounding still applied: what was put to the user is the call that
    // would actually have run.
    expect(harness.requests[0]!.input.run_in_background).toBe(false);
    expect(harness.requests[0]!.outsideEnforcedAllowlist).toBe(true);
    expect(
      harness.logs.filter(
        (entry) => entry.level === "warn" && entry.message.includes("allowlist enforced")
      )
    ).toHaveLength(1);
  });

  test("an approved Agent call outside the enforced allowlist runs foregrounded", async () => {
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL_OR_AGENT,
      enforceAllowedTools: true,
      decision: { behavior: "allow" },
    });

    const outcome = await runToolCall(
      harness.options,
      "Agent",
      { ...BACKGROUND_AGENT_CALL },
      "agent-approved"
    );

    // The rewrite is not the casualty of the fix: the user decided, and what
    // runs is still the foregrounded call rather than the dead background one.
    expect(outcome.executed).toBe(true);
    expect(outcome.input.run_in_background).toBe(false);
  });

  test("a backgrounded Agent call runs when Agent IS on the enforced allowlist", async () => {
    const harness = await startTurn({
      allowedTools: WITH_SHELL_AND_AGENT,
      enforceAllowedTools: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Agent",
      { ...BACKGROUND_AGENT_CALL },
      "agent-allowed"
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.decided).toBe(false);
    expect(outcome.input.run_in_background).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  test("a turn that declares nothing keeps today's Agent behaviour", async () => {
    const harness = await startTurn({ allowedTools: WITHOUT_SHELL_OR_AGENT });

    const outcome = await runToolCall(
      harness.options,
      "Agent",
      { ...BACKGROUND_AGENT_CALL },
      "agent-default"
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.decided).toBe(false);
    expect(outcome.input.run_in_background).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  test("a remote-isolation Agent call is still denied under enforcement", async () => {
    const harness = await startTurn({
      allowedTools: WITH_SHELL_AND_AGENT,
      enforceAllowedTools: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Agent",
      { description: "x", prompt: "y", isolation: "remote" },
      "agent-remote"
    );

    expect(outcome.executed).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });
});

describe("what the host is told about the turn's posture", () => {
  test("a request from a turn that declares nothing carries no enforcement marker", async () => {
    const harness = await startTurn({ allowedTools: WITHOUT_SHELL_OR_AGENT });

    await runToolCall(harness.options, "mcp__external__publish", { id: 7 }, "ext-default");

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.outsideEnforcedAllowlist).toBeUndefined();
  });

  test("a tool ON the enforced allowlist that still reaches the callback is not marked", async () => {
    const harness = await startTurn({
      allowedTools: WITH_SHELL_AND_AGENT,
      enforceAllowedTools: true,
    });

    // The runtime auto-allows an allowlisted tool without the callback; a
    // direct invocation is the one way this pairing is observable, and the
    // marker must follow the allowlist rather than the declaration.
    await harness.options.canUseTool!("Read", { file_path: "/brain/a.md" }, {
      signal: new AbortController().signal,
      toolUseID: "read-allowed",
    } as never);

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.outsideEnforcedAllowlist).toBeUndefined();
  });
});
