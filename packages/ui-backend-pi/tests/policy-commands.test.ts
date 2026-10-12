/** Actual offline fake-git effects behind pi's host RPC and in-process tool gate. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { BackendActivityEvent, PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../src/backend";
import { createPermissionGate } from "../src/permission-gate";
import { createTurnContext } from "../src/turn-context";
import { sendPipe } from "../src/worker-protocol";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const force = { pattern: "^git push (-f|--force)", reason: "No force pushes.", index: 1 };
type Rule = typeof force;
async function probe(binding: "rpc" | "gate", options: { deny?: Rule[]; confirm?: Rule[];
  command: string; decision?: PermissionDecision; allowedTools?: string[]; repeats?: number; cancelOnApproval?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-pi-policy-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), marker = join(root, "executed"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n`, { mode: 0o755 });
  const controller = new AbortController();
  const requests: PermissionRequest[] = [], events: BackendActivityEvent[] = [];
  const commandPolicy = { hash: "odysseus-policy", deny: options.deny ?? [], confirm: options.confirm ?? [] };
  const bridge = { emit: () => {}, activity: (event: BackendActivityEvent) => events.push(event),
    requestPermission: async (request: PermissionRequest) => { requests.push(request); if (options.cancelOnApproval) controller.abort(); return options.decision ?? { behavior: "allow" as const }; } };
  async function execute(input: Record<string, unknown>) {
    const child = Bun.spawn(["/bin/sh", "-c", String(input.command)], { cwd: root, env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  }
  const signal = controller.signal;
  const allowedTools = options.allowedTools ?? ["bash"];
  if (binding === "gate") {
    const turn = { ...createTurnContext(), bridge, signal, commandPolicy };
    let handler: ((event: any) => Promise<any>) | undefined;
    const extension = createPermissionGate({ turn, allowedTools: new Set(allowedTools), confirmPatterns: [] });
    if (typeof extension === "function") throw new Error("Expected named inline permission extension");
    extension.factory({ on: (_name: string, callback: any) => { handler = callback; } } as never);
    for (let index = 0; index < (options.repeats ?? 1); index++) {
      const input = { command: options.command };
      const result = await handler!({ toolName: "bash", input, toolCallId: `odysseus-${index}` });
      if (!result?.block) await execute(input);
    }
  } else {
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    cleanup.push(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
    const host = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true }); cleanup.push(() => host.mockRestore());
    const launch = spyOn(worker, "launchAgentWorker").mockImplementation(() => {
      const stdout = new PassThrough(), stderr = new PassThrough(), exited = Promise.withResolvers<number>();
      let next = 0;
      const stop = () => { stdout.end(); stderr.end(); exited.resolve(0); };
      cleanup.push(stop);
      const ask = () => sendPipe(stdout, { type: "rpc", id: ++next, method: "permission", toolName: "bash", toolCallId: `odysseus-${next}`, input: { command: options.command } });
      const stdin = new Writable({ write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk));
        if (message.type === "init") sendPipe(stdout, { type: "ready", sessionId: message.sessionId, levels: [], cost: 0 });
        else if (message.type === "prompt") ask();
        else if (message.type === "answer") {
          void (async () => {
            if (message.error) throw new Error(message.error);
            if (message.value?.behavior === "allow") await execute(message.value.updatedInput ?? { command: options.command });
            if (next < (options.repeats ?? 1)) ask(); else sendPipe(stdout, { type: "done", cost: 0 });
          })().then(() => callback(), callback);
          return;
        }
        callback();
      } });
      return { stdin, stdout, stderr, exited: exited.promise, kill: stop, limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
    }); cleanup.push(() => launch.mockRestore());
    const brain = join(root, "brain"); mkdirSync(brain);
    await createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions"), allowedTools, confirmBashPatterns: [] }).startTurn({
      prompt: "Return to Ithaca", signal, bridge, workerSandbox: { ...worker.prepareWorkerSandbox(brain), commandPolicy },
    });
  }
  return { requests, events, executed: existsSync(marker), bytes: existsSync(marker) ? readFileSync(marker, "utf8") : null };
}
for (const binding of ["rpc", "gate"] as const) {
  test(`${binding}: policy deny stops real bash and retries before fake git executes`, async () => {
    const result = await probe(binding, { deny: [force], command: "git push --force", repeats: 2 });
    expect(result.executed, "PI_POLICY_DENY_BEFORE_EXECUTION").toBe(false);
    expect(result.requests).toEqual([]);
    expect(result.events.filter(e => e.kind === "policy_block")).toHaveLength(2);
    expect(result.events.find(e => e.kind === "policy_block")).toMatchObject({ payload: { rule: { index: 1 }, policyHash: "odysseus-policy" } });
  });
  test(`${binding}: nonmatching fake git actually runs`, async () => {
    const result = await probe(binding, { deny: [force], command: "git status" });
    expect(result.bytes).toBe("status\n");
  });
  test(`${binding}: declined confirmation runs nothing, including bash outside the allowlist`, async () => {
    const result = await probe(binding, { confirm: [{ ...force, pattern: "^git push" }], command: "git push", allowedTools: [], decision: { behavior: "deny", message: "Declined." } });
    expect(result.executed, "PI_POLICY_CONFIRM_DECLINED").toBe(false);
    expect(result.requests).toHaveLength(1); expect(result.requests[0]?.kind).toBe("command");
    expect(result.events.find(e => e.kind === "policy_confirm")).toMatchObject({ payload: { decision: "declined" } });
  });
  test(`${binding}: approved confirmation runs and omitted bash still needs its separate tool grant`, async () => {
    const result = await probe(binding, { confirm: [{ ...force, pattern: "^git push" }], command: "git push", allowedTools: [] });
    expect(result.bytes).toBe("push\n"); expect(result.requests.map(request => request.kind)).toEqual(["command", "tool"]);
    expect(result.events.filter(e => e.kind === "policy_confirm")).toHaveLength(1);
  });
  test(`${binding}: approved edit into denied bash runs nothing`, async () => {
    const result = await probe(binding, { deny: [force], confirm: [{ ...force, pattern: "^git status" }], command: "git status",
      decision: { behavior: "allow", updatedInput: { command: "git push --force" } } });
    expect(result.executed, "PI_POLICY_EDIT_DENY_BEFORE_EXECUTION").toBe(false);
    expect(result.events.some(e => e.kind === "policy_block")).toBe(true);
  });
}
