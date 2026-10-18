import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { savePiSession } from "../src/session-storage.js";
import { createPiBackend } from "../src/backend.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";

for (const mode of ["none", "header", "late", "cancel", "multiple", "resume"]) test(`direct authorized application receipt: ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-direct-receipt-")), brain = join(root, "ithaca"), sessionDir = join(root, "sessions");
  mkdirSync(join(brain, "notes"), { recursive: true }); mkdirSync(sessionDir);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const children: ReturnType<typeof spawn>[] = [], exits: Promise<number>[] = [];
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const launch = spyOn(worker, "launchAgentWorker").mockImplementation(() => {
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/direct-application-worker.ts")], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH! } });
    children.push(child);
    const exited = new Promise<number>((resolve, reject) => { child.once("exit", (code, signal) => { expect(signal === "SIGKILL" || code === 0).toBe(true); resolve(code ?? 128); }); child.once("error", reject); });
    exits.push(exited);
    return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exited,
      kill: (signal?: NodeJS.Signals) => child.kill(signal), limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  try {
    const resumeId = "11111111-1111-4111-8111-111111111111";
    if (mode === "resume") savePiSession(sessionDir, resumeId, [
      { type: "session", version: 3, id: resumeId, cwd: brain, timestamp: "2026-07-12T00:00:00.000Z" },
      { type: "message", id: "prior-user", parentId: null, timestamp: "2026-07-12T00:00:00.000Z", message: { role: "user", content: "Earlier voyage", timestamp: 0 } },
    ]);
    const before = mode === "resume" ? readFileSync(join(sessionDir, `${resumeId}.jsonl`), "utf8") : undefined;
    const backend = createPiBackend({ brainPath: brain, sessionDir }), frames: ServerMessage[] = [];
    let applications = 0;
    const controller = new AbortController();
    await backend.startTurn({ prompt: mode, ...(mode === "resume" ? { sessionId: resumeId } : {}), signal: controller.signal, bridge: {
      emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "deny", message: "No generic grants" }),
      applyBrain: async input => {
        expect(input).toEqual({ operation: "write", path: "notes/raft.md", content: "Odysseus repairs the raft.\n", expectedBaseHash: null });
        applications++; writeFileSync(join(brain, "notes/raft.md"), "Odysseus repairs the raft.\n");
        if (mode === "cancel") controller.abort();
        return { ok: true, message: "Committed the direct raft plan", changes: [{ path: "notes/raft.md", contentHash: createHash("sha256").update("Odysseus repairs the raft.\n").digest("hex") }] };
      },
    } });
    expect(applications, "ACTUAL_PARENT_RPC_COMMITTED_EFFECT").toBe(mode === "multiple" ? 2 : 1);
    expect(readFileSync(join(brain, "notes/raft.md"), "utf8")).toBe("Odysseus repairs the raft.\n");
    const result = frames.findLast(frame => frame.type === "result"); expect(result).toBeDefined();
    if (!result) throw new Error("Missing terminal result");
    expect(result.outcome).toBe(mode === "cancel" ? "cancelled" : "success");
    expect(existsSync(join(sessionDir, `${result.sessionId}.jsonl`)), "NO_MANUFACTURED_PROVIDER_TRANSCRIPT").toBe(mode === "late" || mode === "resume");
    if (before !== undefined) expect(readFileSync(join(sessionDir, `${resumeId}.jsonl`), "utf8"), "RESUMED_DIRECT_EFFECT_PRESERVES_ALL_NATIVE_BYTES").toBe(before);
    if (mode === "late") {
      const native = readFileSync(join(sessionDir, `${result.sessionId}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(native.map(entry => entry.type), "ONLY_RUNTIME_HEADER_AND_USER").toEqual(["session", "message"]);
      expect(native[1].message).toEqual({ role: "user", content: "Next voyage", timestamp: 1 });
    }
    const reloaded = createPiBackend({ brainPath: brain, sessionDir });
    const history = await reloaded.getHistory(result.sessionId);
    if (mode === "late") expect(history.map(message => message.role), "DIRECT_EFFECT_KEEPS_PRE_SNAPSHOT_POSITION").toEqual(["assistant", "user"]);
    if (mode === "resume") expect(history.map(message => message.role), "DIRECT_EFFECT_FOLLOWS_PRIOR_NATIVE_LEAF").toEqual(["user", "assistant"]);
    const calls = history.flatMap(message => message.toolCalls);
    expect(calls, "DIRECT_EFFECT_VISIBLE_WITHOUT_NATIVE_HISTORY").toHaveLength(mode === "multiple" ? 2 : 1);
    if (mode === "multiple") expect(calls.map(call => call.id), "DIRECT_RECEIPTS_KEEP_COMMIT_ORDER").toEqual(["direct-raft", "direct-mast"]);
    expect(calls[0]).toMatchObject({ id: "direct-raft", output: expect.stringContaining("Committed the direct raft plan"), isError: false });
    expect(await reloaded.getHistory("22222222-2222-4222-8222-222222222222"), "UNRELATED_SESSION_HAS_NO_RECEIPT").toEqual([]);
  } finally {
    children.forEach(child => child.kill("SIGKILL")); await Promise.allSettled(exits);
    launch.mockRestore(); probe.mockRestore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
