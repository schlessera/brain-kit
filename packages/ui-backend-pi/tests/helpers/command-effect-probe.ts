import { createFixtureMaintenanceHost } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
/** Actual offline fake-git effects behind pi's host RPC and in-process tool gate. */
import { expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { BackendActivityEvent, PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../../src/backend";
import { createPermissionGate } from "../../src/permission-gate";
import { createTurnContext } from "../../src/turn-context";
import { sendPipe } from "../../src/worker-protocol";

const force = { pattern: "^git push (-f|--force)", reason: "No force pushes.", index: 1 };
type Rule = typeof force;
export async function probe(binding: "rpc" | "gate", options: { deny?: Rule[]; confirm?: Rule[];
  command: string; decision?: PermissionDecision; allowedTools?: string[]; repeats?: number; cancelOnApproval?: boolean; outwardAllow?: Array<{ command: string; remotes: string[]; index: number }>; voice?: boolean }) {
  const cleanup: Array<() => void> = [];
  try {
    const root = mkdtempSync(join(tmpdir(), "odysseus-pi-policy-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    installGitIdentity(root);
    const bin = join(root, "bin"), marker = join(root, "executed"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n`, { mode: 0o755 });
    const maintenance = createFixtureMaintenanceHost(root); cleanup.push(() => maintenance.cleanup());
    const controller = new AbortController();
    for (const name of ["gh", "curl", "wget"]) writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n`, { mode: 0o755 });
    const requests: PermissionRequest[] = [], events: BackendActivityEvent[] = [];
    const commandPolicy = { outwardAllow: options.outwardAllow ?? [], hash: "odysseus-policy", deny: options.deny ?? [], confirm: options.confirm ?? [] };
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
      const turn = { ...createTurnContext(), bridge, signal, commandPolicy, configurationRoot: root, maintenance, ...(options.voice ? { posture: "voice" as const, noGrantSurface: true, enforceAllowedTools: true } : {}) };
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
        const configurationRoot = join(root, "brain");
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
        return { configurationRoot, stdin, stdout, stderr, exited: exited.promise, kill: stop, limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
      }); cleanup.push(() => launch.mockRestore());
      const brain = join(root, "brain"); mkdirSync(brain);
      installGitIdentity(brain);
      const brainMaintenance = createFixtureMaintenanceHost(brain); cleanup.push(() => brainMaintenance.cleanup());
      const start = createPiBackend({ maintenance: brainMaintenance, brainPath: brain, sessionDir: join(root, "sessions"), allowedTools, confirmBashPatterns: [] }).startTurn({
        prompt: "Return to Ithaca", signal, bridge, workerSandbox: { ...worker.prepareWorkerSandbox(brain), commandPolicy },
        ...(options.voice ? { posture: "voice" as const, enforceAllowedTools: true, noGrantSurface: true } : {}),
      });
      if (options.voice) {
        await expect(start).rejects.toThrow("The pi backend declares no voice tool posture");
        expect(launch).not.toHaveBeenCalled();
      } else await start;
    }
    return { requests, events, executed: existsSync(marker), bytes: existsSync(marker) ? readFileSync(marker, "utf8") : null };
  } finally {
    for (const close of cleanup.reverse()) close();
  }
}
function installGitIdentity(root: string) {
  for (const rel of [".git/objects", ".git/refs/heads"]) mkdirSync(join(root, rel), { recursive: true });
  writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git/config"), "[core]\n repositoryformatversion = 0\n bare = false\n[remote \"origin\"]\n url = https://github.com/odysseus/voyage.git\n");
}
