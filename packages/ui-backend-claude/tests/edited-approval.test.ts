/**
 * An approval that comes back with an edited input is re-checked before it is
 * applied (#145).
 *
 * A card shows one input; the host can answer it with another
 * (`updatedInput`). Applying that unchecked lets an approval redirect the call
 * it confirmed — an archive approved against one document executing against a
 * different one. So the edit is put back through the shared policy, and a
 * confirmation the card did not show refuses the call.
 *
 * On the PreToolUse path an edit that passes is applied by returning
 * `updatedInput` with NO `permissionDecision`. Measured against the runtime
 * `MEASURED_RUNTIME` names (scripts/measure-claude-runtime.ts): the
 * rewrite applies without a decision, so no path gains an `allow`. The same
 * probe found that matching PreToolUse hooks run in PARALLEL, each sees the
 * ORIGINAL input, and the `updatedInput` of whichever finishes LAST is the
 * one that runs — which is why the rtk rewrite hook stays silent on a call
 * that raises a confirmation (last case below).
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
import { createKeyedLock, resetRtkProbe } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { BRAIN_UPDATE_TOOL, MUTATING_TOOL_MATCHER } from "../src/tool-policy";

interface HookOutput {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

interface Turn {
  options: Options;
  requests: PermissionRequest[];
  /** Lock keys held at the moment the probe inside the turn finished. */
  heldKeys: string[];
  /** What the probe returned. */
  value: unknown;
}

/**
 * Run one turn and, while it is live, hand its SDK options to `probe` — the
 * way the runtime would call the hooks and `canUseTool` mid-turn.
 */
async function duringTurn(setup: {
  decision: PermissionDecision;
  allowedTools?: string[];
  enforceAllowedTools?: boolean;
  probe: (options: Options) => Promise<unknown>;
}): Promise<Turn> {
  const requests: PermissionRequest[] = [];
  const writeLock = createKeyedLock();
  const bridge: BackendBridge = {
    emit: () => {},
    requestPermission: async (request) => {
      requests.push(request);
      return setup.decision;
    },
  };
  let options: Options | undefined;
  let heldKeys: string[] = [];
  let value: unknown;
  const queryFn = ((params: { options?: Options }) => {
    options = params.options!;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "edited" };
      value = await setup.probe(options!);
      heldKeys = [...writeLock.heldKeys];
      yield {
        type: "result",
        subtype: "success",
        session_id: "edited",
        total_cost_usd: 0,
        duration_ms: 1,
        num_turns: 1,
      };
    })();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({
    brainPath: "/brain",
    queryFn,
    writeLock,
    log: () => {},
    ...(setup.allowedTools ? { allowedTools: setup.allowedTools } : {}),
  });
  await backend.startTurn({
    prompt: "edit the approval",
    signal: new AbortController().signal,
    bridge,
    ...(setup.enforceAllowedTools ? { enforceAllowedTools: true } : {}),
  });
  return { options: options!, requests, heldKeys, value };
}

function hookFor(options: Options, matcher: string): HookCallback {
  const group = options.hooks?.PreToolUse?.find((entry) => entry.matcher === matcher);
  if (!group) throw new Error(`missing PreToolUse hook for ${matcher}`);
  return group.hooks[0]!;
}

function callHook(
  hook: HookCallback,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string
): Promise<HookOutput> {
  return hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: input,
      tool_use_id: toolUseId,
    } as never,
    toolUseId,
    { signal: new AbortController().signal }
  ) as Promise<HookOutput>;
}

/** The confirmation hook for one call, with the host answering `decision`. */
async function confirm(
  toolName: string,
  input: Record<string, unknown>,
  decision: PermissionDecision,
  extra: { enforceAllowedTools?: boolean; allowedTools?: string[] } = {}
): Promise<Turn & { output: HookOutput }> {
  const turn = await duringTurn({
    decision,
    ...extra,
    probe: (options) =>
      callHook(hookFor(options, MUTATING_TOOL_MATCHER), toolName, input, "confirm-1"),
  });
  return { ...turn, output: turn.value as HookOutput };
}

const ARCHIVE = { path: "notes/a.md", status: "archived" };

describe("PreToolUse: an edit that passes the re-check", () => {
  test("is applied as updatedInput with no permissionDecision", async () => {
    const edited = { path: "notes/a.md", status: "archived", summary: "Superseded." };
    const { output, requests } = await confirm(BRAIN_UPDATE_TOOL, ARCHIVE, {
      behavior: "allow",
      updatedInput: edited,
    });

    expect(requests).toHaveLength(1);
    // Asserted as the whole output: no `permissionDecision` key at all, so
    // the edit cannot also grant the call past the rest of the runtime.
    expect(output).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: edited },
    });
  });

  test("an edit that removes the need for confirmation is applied too", async () => {
    const edited = { command: "git status --short" };
    const { output } = await confirm(
      "Bash",
      { command: "git reset --hard HEAD~1" },
      { behavior: "allow", updatedInput: edited }
    );

    expect(output).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: edited },
    });
  });

  test("the lock is taken on the key of the edited input, not the original", async () => {
    // `rm -rf scratch` takes no lock; the edit needs no confirmation of its
    // own but is a staging write, which has to hold the git lock while it runs.
    const { output, heldKeys } = await confirm(
      "Bash",
      { command: "rm -rf scratch" },
      { behavior: "allow", updatedInput: { command: "git add -A" } }
    );

    expect(output.hookSpecificOutput?.updatedInput).toEqual({ command: "git add -A" });
    expect(heldKeys).toEqual(["repo-git"]);
  });
});

describe("PreToolUse: an edit that fails the re-check", () => {
  test("moving a confirmed archive to another document is denied", async () => {
    const { output, heldKeys } = await confirm(BRAIN_UPDATE_TOOL, ARCHIVE, {
      behavior: "allow",
      updatedInput: { path: "notes/b.md", status: "archived" },
    });

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(BRAIN_UPDATE_TOOL);
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("did not run");
    expect(output.hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(heldKeys).toEqual([]);
  });

  test("a confirmed command edited to another on the same pattern is denied", async () => {
    // `brain archive` of a different document matches the same pattern; the
    // card confirmed the command it showed, not the pattern.
    const { output } = await confirm(
      "Bash",
      { command: "brain archive notes/a.md" },
      { behavior: "allow", updatedInput: { command: "brain archive notes/b.md" } }
    );

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.updatedInput).toBeUndefined();
  });

  test("an edit into a command matching a pattern the card did not show is denied", async () => {
    const { output } = await confirm(
      "Bash",
      { command: "rm -rf scratch" },
      { behavior: "allow", updatedInput: { command: "git push --force origin main" } }
    );

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("Bash");
    expect(output.hookSpecificOutput?.updatedInput).toBeUndefined();
  });
});

describe("PreToolUse: an edited approval never becomes an allow", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["Bash", { command: "rm -rf scratch" }, { command: "rm -rf scratch/old" }],
    ["Bash", { command: "rm -rf scratch" }, { command: "git clean -fd" }],
    ["Bash", { command: "git reset --hard" }, { command: "git status" }],
    [BRAIN_UPDATE_TOOL, ARCHIVE, { ...ARCHIVE, summary: "Gone." }],
    [BRAIN_UPDATE_TOOL, ARCHIVE, { path: "notes/b.md", status: "archived" }],
    [BRAIN_UPDATE_TOOL, ARCHIVE, { path: "notes/a.md", status: "draft" }],
  ];
  for (const enforceAllowedTools of [false, true]) {
    test(`for any edit, passing or failing${enforceAllowedTools ? ", under enforcement" : ""}`, async () => {
      for (const [tool, original, edited] of cases) {
        const { output, requests } = await confirm(
          tool,
          original,
          { behavior: "allow", updatedInput: edited },
          {
            enforceAllowedTools,
            allowedTools: ["Read", "Bash", BRAIN_UPDATE_TOOL],
          }
        );
        expect(requests, `${tool} ${JSON.stringify(edited)} must ask`).toHaveLength(1);
        expect(
          output.hookSpecificOutput?.permissionDecision,
          `${tool} ${JSON.stringify(edited)}`
        ).not.toBe("allow");
      }
    });
  }
});

describe("canUseTool: the edit is re-checked there too", () => {
  test("an edit that smuggles in a confirmation behind a tool grant is denied", async () => {
    // Bash is off this allowlist, so the card is a tool grant for `ls`. An
    // approval that turns it into a recursive delete would skip the
    // per-use confirmation the PreToolUse hook raised for `ls` — none.
    const turn = await duringTurn({
      decision: { behavior: "allow", updatedInput: { command: "rm -rf notes" } },
      allowedTools: ["Read"],
      probe: (options) =>
        options.canUseTool!("Bash", { command: "ls" }, {
          signal: new AbortController().signal,
          toolUseID: "grant-1",
        } as never),
    });

    expect(turn.requests).toHaveLength(1);
    expect(turn.value).toMatchObject({ behavior: "deny" });
    expect((turn.value as { message: string }).message).toContain("Bash");
    expect(turn.heldKeys).toEqual([]);
  });

  test("a confirmed command retargeted on the same pattern is denied here too", async () => {
    const turn = await duringTurn({
      decision: { behavior: "allow", updatedInput: { command: "brain archive notes/b.md" } },
      allowedTools: ["Read"],
      probe: (options) =>
        options.canUseTool!("Bash", { command: "brain archive notes/a.md" }, {
          signal: new AbortController().signal,
          toolUseID: "grant-retarget",
        } as never),
    });

    expect(turn.value).toMatchObject({ behavior: "deny" });
    expect((turn.value as { updatedInput?: unknown }).updatedInput).toBeUndefined();
    expect(turn.heldKeys).toEqual([]);
  });

  test("an edit that passes is applied, with the lock on the edited input's key", async () => {
    const turn = await duringTurn({
      decision: { behavior: "allow", updatedInput: { command: "git add -A" } },
      allowedTools: ["Read"],
      probe: (options) =>
        options.canUseTool!("Bash", { command: "ls" }, {
          signal: new AbortController().signal,
          toolUseID: "grant-2",
        } as never),
    });

    expect(turn.value).toEqual({ behavior: "allow", updatedInput: { command: "git add -A" } });
    expect(turn.heldKeys).toEqual(["repo-git"]);
  });
});

describe("the rtk rewrite does not race a confirmation", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  /** A stand-in rtk on PATH that proxies every command it is shown. */
  function withFakeRtk(): () => void {
    const directory = mkdtempSync(join(tmpdir(), "brain-145-rtk-"));
    const binary = join(directory, "rtk");
    writeFileSync(
      binary,
      "#!/bin/sh\n" +
        'if [ "$1" = "--version" ]; then exit 0; fi\n' +
        "printf '%s\\n' '{\"hookSpecificOutput\":{\"updatedInput\":{\"command\":\"rtk proxied\"}}}'\n"
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

  test("a command that raises a confirmation is left alone by the rewrite hook", async () => {
    // The two hooks run in parallel and the later finisher's updatedInput
    // wins, so a rewrite of the ORIGINAL command could land over the
    // approved edit, or over the confirmed call itself.
    restore = withFakeRtk();
    const turn = await duringTurn({
      decision: { behavior: "allow" },
      probe: (options) =>
        callHook(hookFor(options, "^Bash$"), "Bash", { command: "rm -rf scratch" }, "rtk-1"),
    });

    expect(turn.value).toEqual({ continue: true });
  });

  test("an ordinary command is still rewritten", async () => {
    restore = withFakeRtk();
    const turn = await duringTurn({
      decision: { behavior: "allow" },
      probe: (options) =>
        callHook(hookFor(options, "^Bash$"), "Bash", { command: "git status" }, "rtk-2"),
    });

    expect((turn.value as HookOutput).hookSpecificOutput?.updatedInput).toEqual({
      command: "rtk proxied",
    });
  });
});
