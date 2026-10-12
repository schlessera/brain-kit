/** Hand-driven SDK hooks, with actual offline fake-git execution as the negative control. */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createKeyedLock, type BackendActivityEvent, type PermissionDecision, type PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import type { WorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createPermissionWiring } from "../src/permission-hooks";
import { createTurnLockBinding } from "../src/turn-lock";
import { MUTATING_TOOL_MATCHER } from "../src/tool-policy";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Rule = { pattern: string; reason?: string; index: number };
async function probe(options: { deny?: Rule[]; confirm?: Rule[]; command: string;
  decision?: PermissionDecision; callback?: boolean; repeats?: number; cancelOnApproval?: boolean; noGrantSurface?: boolean; rewrite?: string }) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-command-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  const marker = join(root, "executed");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n`, { mode: 0o755 });
  const rewriteMarker = join(root, "rewritten");
  if (options.rewrite) writeFileSync(join(bin, "rtk"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'rtk fixture\\n'; exit 0; fi
/bin/cat >/dev/null
printf ran > '${rewriteMarker}'
printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { updatedInput: { command: options.rewrite } } })}'
`, { mode: 0o755 });
  const controller = new AbortController(), signal = controller.signal;
  const requests: PermissionRequest[] = [], events: BackendActivityEvent[] = [];
  const turnLock = createTurnLockBinding({ turn: { ended: false, pendingReleases: new Map() },
    writeLock: createKeyedLock(), lockWaitMs: 1000, log: () => {}, admission: { signal } });
  const commandPolicy = { hash: "odysseus-policy", deny: options.deny ?? [], confirm: options.confirm ?? [] };
  const wiring = createPermissionWiring({ req: { prompt: "Return to Ithaca", signal,
    workerSandbox: { commandPolicy } as unknown as WorkerSandbox, noGrantSurface: options.noGrantSurface,
    bridge: { emit: () => {}, activity: event => events.push(event), requestPermission: async request => {
      requests.push(request); if (options.cancelOnApproval) controller.abort(); return options.decision ?? { behavior: "allow" };
    } } }, allowedTools: ["Bash"], confirmPatterns: [], brainPath: root, turnLock,
    childEnv: { PATH: bin }, log: () => {} });
  const hook = wiring.hooks!.PreToolUse!.find(group => group.matcher === (options.rewrite ? "^Bash$" : MUTATING_TOOL_MATCHER))!.hooks[0]!;
  const outputs: Array<Awaited<ReturnType<HookCallback>> | Awaited<ReturnType<NonNullable<typeof wiring.canUseTool>>>> = [];
  try {
    for (let index = 0; index < (options.repeats ?? 1); index++) {
      const input = { command: options.command }, id = `odysseus-${index}`;
      const output = options.callback
        ? await wiring.canUseTool!("Bash", input, { toolUseID: id, signal } as never)
        : await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: input, tool_use_id: id } as never,
          id, { signal });
      if (!output) throw new Error("Permission binding returned no result");
      outputs.push(output);
      const specific = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
      const denied = "behavior" in output ? output.behavior === "deny"
        : specific?.hookEventName === "PreToolUse" && specific.permissionDecision === "deny";
      if (!denied) {
        const edited = "updatedInput" in output ? output.updatedInput : specific?.hookEventName === "PreToolUse" ? specific.updatedInput : undefined;
        const effective = edited ?? input;
        const child = Bun.spawn(["/bin/sh", "-c", String(effective.command)], { cwd: root,
          env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(child.stderr).text();
        expect(await child.exited, stderr).toBe(0);
      }
    }
    return { requests, events, outputs, rewritten: existsSync(rewriteMarker), executed: existsSync(marker),
      bytes: existsSync(marker) ? readFileSync(marker, "utf8") : null };
  } finally { turnLock.close(); }
}

const force = { pattern: "^git push (-f|--force)", reason: "No force pushes.", index: 0 };
test("policy deny stops actual Bash and identical retries before fake git runs", async () => {
  const receipt = await probe({ deny: [force], command: "git push --force", repeats: 2 });
  expect(receipt.executed, "CLAUDE_POLICY_DENY_BEFORE_EXECUTION").toBe(false);
  expect(receipt.requests).toEqual([]);
  expect(JSON.stringify(receipt.outputs)).toContain("commands.deny[0]");
  expect(JSON.stringify(receipt.outputs)).toContain(force.reason);
  expect(receipt.events.filter(event => event.kind === "policy_block")).toHaveLength(2);
});
test("the negative control actually executes a nonmatching fake git command", async () => {
  const receipt = await probe({ deny: [force], command: "git status" });
  expect(receipt.executed).toBe(true);
  expect(receipt.bytes).toBe("status\n");
  expect(receipt.requests).toEqual([]);
});
test("policy confirmation uses the existing per-use card and declining runs nothing", async () => {
  const receipt = await probe({ confirm: [{ pattern: "^git push", reason: "Pushing leaves the host.", index: 0 }],
    command: "git push", decision: { behavior: "deny", message: "Declined." } });
  expect(receipt.executed, "CLAUDE_POLICY_CONFIRM_DECLINED").toBe(false);
  expect(receipt.requests).toHaveLength(1);
  expect(receipt.requests[0]).toMatchObject({ kind: "command", description: "Pushing leaves the host." });
});
for (const callback of [false, true]) test(`approved edits into denied Bash run nothing (${callback ? "callback" : "hook"})`, async () => {
  const receipt = await probe({ deny: [force], command: "git status", callback,
    confirm: callback ? [] : [{ pattern: "^git status", reason: "Review this command.", index: 0 }],
    decision: { behavior: "allow", updatedInput: { command: "git push --force" } } });
  expect(receipt.executed, "CLAUDE_POLICY_EDIT_DENY_BEFORE_EXECUTION").toBe(false);
  expect(receipt.requests).toHaveLength(1);
  expect(receipt.events.some(event => event.kind === "policy_block")).toBe(true);
});

test("approved policy confirmation executes exactly the command shown", async () => {
  const receipt = await probe({ confirm: [{ pattern: "^git push", reason: "Review pushing.", index: 1 }], command: "git push" });
  expect(receipt.bytes).toBe("push\n");
  expect(receipt.events.find(e => e.kind === "policy_confirm")).toMatchObject({ payload: { decision: "approved", rule: { index: 1 } } });
});
test("cancellation during an approval prevents actual execution", async () => {
  const receipt = await probe({ confirm: [{ pattern: "^git push", reason: "Review pushing.", index: 1 }], command: "git push", cancelOnApproval: true });
  expect(receipt.executed).toBe(false);
  expect(receipt.events.find(e => e.kind === "policy_confirm")).toMatchObject({ payload: { decision: "cancelled" } });
});
test("a no-grant turn refuses policy confirmation without raising a card", async () => {
  const receipt = await probe({ confirm: [{ pattern: "^git push", reason: "Review pushing.", index: 1 }], command: "git push", noGrantSurface: true });
  expect(receipt.executed).toBe(false); expect(receipt.requests).toEqual([]);
});

for (const list of ["deny", "confirm"] as const) test(`RTK cannot rewrite a permitted input into a policy ${list}`, async () => {
  const receipt = await probe({ [list]: [force], command: "git status", rewrite: "git push --force" });
  expect(receipt.rewritten, "RTK_ORACLE_ACTUALLY_RAN").toBe(true);
  expect(receipt.executed, "CLAUDE_REWRITTEN_POLICY_BEFORE_EXECUTION").toBe(false);
});
