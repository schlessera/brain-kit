/** Hand-driven SDK hooks, with actual offline fake-git execution as the negative control. */
import { afterEach, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createKeyedLock, type BackendActivityEvent, type PermissionDecision, type PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import type { WorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createPermissionWiring } from "../../src/permission-hooks";
import { createTurnLockBinding } from "../../src/turn-lock";
import { MUTATING_TOOL_MATCHER } from "../../src/tool-policy";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Rule = { pattern: string; reason?: string; index: number };
export async function probe(options: { deny?: Rule[]; confirm?: Rule[]; command: string;
  decision?: PermissionDecision; callback?: boolean; repeats?: number; cancelOnApproval?: boolean; noGrantSurface?: boolean; rewrite?: string; outwardAllow?: Array<{ command: string; remotes: string[]; index: number }>; voice?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-command-")); roots.push(root);
  for (const rel of [".git/objects", ".git/refs/heads"]) mkdirSync(join(root, rel), { recursive: true });
  writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git/config"), "[core]\n repositoryformatversion = 0\n bare = false\n[remote \"origin\"]\n url = https://github.com/odysseus/voyage.git\n");
  const bin = join(root, "bin"); mkdirSync(bin);
  const marker = join(root, "executed");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n`, { mode: 0o755 });
  for (const name of ["gh", "curl", "wget"]) writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n`, { mode: 0o755 });
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
  const commandPolicy = { outwardAllow: options.outwardAllow ?? [], hash: "odysseus-policy", deny: options.deny ?? [], confirm: options.confirm ?? [] };
  const wiring = createPermissionWiring({ req: { prompt: "Return to Ithaca", signal,
    workerSandbox: { commandPolicy, brain: root, profile: "governed" } as unknown as WorkerSandbox,
    ...(options.voice ? { posture: "voice" as const, enforceAllowedTools: true } : {}), noGrantSurface: options.noGrantSurface,
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
