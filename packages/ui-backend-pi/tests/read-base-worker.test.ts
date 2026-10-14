import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { PermissionRequest, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../src/backend";

// Like native-session-versions, this launches a real offline child with the
// curated tool and real host RPC dispatcher. The launcher/probe are replaced;
// this tests admission and grant binding, not OS containment or live inference.
for (const mode of ["default", "narrowed", "absent", "forged-tool", "mismatched-path", "consumed", "revoked"]) {
  test(`native read-base ${mode}: exact host grant and authoritative bytes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-read-base-")), brain = join(root, "brain");
    mkdirSync(join(brain, "notes"), { recursive: true });
    const content = "Odysseus returns to Ithaca.\n", hash = createHash("sha256").update(content).digest("hex");
    writeFileSync(join(brain, "notes/odysseus.md"), content);
    writeFileSync(join(brain, "notes/athena.md"), "Athena charts the voyage.\n");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const controller = new AbortController(), frames: ServerMessage[] = [], permissions: PermissionRequest[] = [], reads: string[] = [];
    const exits: Promise<number>[] = [];
    const stopChildren: Array<() => void> = [];
    const terminations: Array<{ code: number | null; signal: string | null }> = [];
    const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
    const launch = spyOn(worker, "launchAgentWorker").mockImplementation(() => {
      const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/read-base-worker.ts")], {
        stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH! },
      });
      stopChildren.push(() => { child.kill("SIGKILL"); });
      const exited = new Promise<number>((resolve, reject) => {
        child.once("exit", (code, signal) => { terminations.push({ code, signal }); resolve(code ?? 128); });
        child.once("error", reject);
      });
      exits.push(exited);
      return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exited, kill: (signal?: NodeJS.Signals) => child.kill(signal),
        limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
    });
    try {
      const backend = createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions"),
        ...(mode === "narrowed" ? { allowedTools: ["brain_read"] } : {}) });
      await backend.startTurn({ prompt: mode, signal: controller.signal,
        enforceAllowedTools: mode === "narrowed",
        workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
        bridge: {
          emit(frame) {
            frames.push(frame);
            if (mode === "revoked" && frame.type === "tool_use_start") controller.abort(new Error("Odysseus revoked the turn"));
          },
          requestPermission: async request => { permissions.push(request); return { behavior: "deny", message: "operator excluded base reads" }; },
          readBrainBase: async path => {
            reads.push(path);
            const bytes = readFileSync(join(brain, path), "utf8");
            return { content: bytes, expectedBaseHash: createHash("sha256").update(bytes).digest("hex") };
          },
        } });
      expect(launch).toHaveBeenCalledTimes(1);
      if (mode === "default") {
        expect(permissions, "DEFAULT_READ_HAS_NO_APPROVAL_CARD").toHaveLength(0);
        expect(reads).toEqual(["notes/odysseus.md"]);
        const result = frames.find(frame => frame.type === "tool_result");
        expect(result).toMatchObject({ isError: false });
        expect(JSON.parse(result!.output)).toEqual({ content, expectedBaseHash: hash, bytes: Buffer.byteLength(content), lines: 1 });
        expect(frames.find(frame => frame.type === "result")).toMatchObject({ outcome: "success" });
      } else if (mode === "revoked") {
        expect(reads, "REVOKED_READ_RETURNS_NO_CONTENT").toEqual([]);
        expect(frames.find(frame => frame.type === "result")).toMatchObject({ outcome: "cancelled" });
      } else {
        expect(reads, "UNMATCHED_GRANT_NEVER_REACHES_READER").toEqual(mode === "consumed" ? ["notes/odysseus.md"] : []);
        expect(frames.find(frame => frame.type === "tool_result")).toMatchObject({ isError: true });
        expect(JSON.stringify(frames)).not.toContain(hash);
        if (mode === "narrowed") expect(permissions).toMatchObject([{ toolName: "brain_read_base", outsideEnforcedAllowlist: true }]);
        else expect(permissions).toHaveLength(0);
      }
      // Normal EOF or the host's explicit SIGKILL shutdown; no crash is hidden
      // by treating every signal's null exit code as a successful exit.
      await Promise.all(exits);
      expect(terminations).toHaveLength(1);
      expect([{ code: 0, signal: null }, { code: null, signal: "SIGKILL" }]).toContainEqual(terminations[0]);
    } finally {
      controller.abort();
      for (const stop of stopChildren) stop();
      await Promise.allSettled(exits);
      launch.mockRestore(); probe.mockRestore();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
