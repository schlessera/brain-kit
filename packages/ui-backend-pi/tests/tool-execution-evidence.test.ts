import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { createKeyedLock, type ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../src/backend";

/**
 * #2834: the host's own record of each call's RPCs, not its name, decides
 * the evidence a governed turn reports before the call's result.
 */
async function evidence(loadExtensions: boolean | undefined, modes: string[], loadedExtensions?: number) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-pi-evidence-")), brain = join(root, "brain");
  mkdirSync(brain); writeFileSync(join(brain, "loom.md"), "Penelope weaves.\n");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async () => {
    const env = { ...process.env };
    if (loadedExtensions === undefined) delete env.ODYSSEUS_LOADED_EXTENSIONS; else env.ODYSSEUS_LOADED_EXTENSIONS = String(loadedExtensions);
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/tool-execution-worker.ts")], { stdio: ["pipe", "pipe", "pipe"], env });
    const exited = new Promise<number>((resolve, reject) => { child.once("exit", code => resolve(code ?? 0)); child.once("error", reject); });
    return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exited, kill: () => child.kill(),
      observeFile: worker.createWorkerFileObserver({ brain, configurationRoot: brain, areas: [] }),
      limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  const reported: Record<string, Record<string, (string | null)[]>> = {};
  const key = (id: string) => id.replace(/^toolu_ithaca_/, "");
  try {
    const backend = createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions"), ...(loadExtensions === undefined ? {} : { loadExtensions }) });
    let sessionId: string | undefined;
    for (const mode of modes) {
      const frames: ServerMessage[] = [], proofs: [string, string][] = [], turn: Record<string, (string | null)[]> = reported[mode] = {};
      await backend.startTurn({ sessionId, prompt: mode, signal: new AbortController().signal, workerLock: createKeyedLock(),
        toolExecution: (toolUseId, path) => { proofs.push([toolUseId, path]); },
        workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
        bridge: { emit: frame => {
          // Evidence precedes the result it qualifies.
          if (frame.type === "tool_result") {
            const callId = frame.toolUseId;
            (turn[key(callId)] ??= []).push(proofs.find(([id]) => id === callId)?.[1] ?? null);
            proofs.splice(0, proofs.length, ...proofs.filter(([id]) => id !== callId));
          }
          frames.push(frame); if ("sessionId" in frame) sessionId ??= frame.sessionId;
        }, requestPermission: async () => ({ behavior: "allow" }),
        readBrainBase: async () => ({ content: "Penelope weaves.\n", expectedBaseHash: "0".repeat(64) }) } });
      expect(frames.filter(frame => frame.type === "tool_result" && frame.isError), `PI_EVIDENCE_${mode.toUpperCase()}_RESULTS`).toEqual([]);

    }
    return { reported };
  } finally {
    launch.mockRestore(); probe.mockRestore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("an extension-free worker proves curated reads, writes and host bridge calls from their RPCs", async () => {
  const { reported } = await evidence(false, ["read", "edit", "write", "base", "grep", "locked-read", "silent-read", "half-read"]);
  expect(Object.fromEntries(Object.entries(reported).map(([mode, turn]) => [mode, turn[`0_${mode}`]![0]])), "PI_EVIDENCE_BY_ACTUAL_EXECUTION_PATH").toEqual({
    read: "worker_read", edit: "worker_write", write: "worker_write", base: "host_bridge",
    // No host RPC shows what grep's subprocess did.
    grep: null,
    // A read that took the write lock, or did not report its whole read, proves nothing.
    "locked-read": null, "silent-read": null, "half-read": null,
  });
}, 30_000);

test("once a worker admits a call that can run other code, or reuses a running call's id, it proves nothing more", async () => {
  const { reported } = await evidence(false, ["read,grep,read", "forged,base", "read,dup-read,base"]);
  expect(reported, "PI_EVIDENCE_ENDS_WITH_UNPROVABLE_CODE").toEqual({
    "read,grep,read": { "0_read": ["worker_read"], "1_grep": [null], "2_read": [null] },
    // brain_search's own code reporting a host read under the search's id.
    "forged,base": { "0_forged": [null], "1_base": [null] },
    // A second start under a running call's id: that call, and anything after it, proves nothing.
    "read,dup-read,base": { "0_read": ["worker_read", null], "2_base": [null] },
  });
}, 30_000);

test("a worker that loads extensions proves no call, a curated read included", async () => {
  const { reported } = await evidence(true, ["read", "base"]);
  expect(reported, "PI_EXTENSION_WORKER_PROVES_NOTHING_true").toEqual({ read: { "0_read": [null] }, base: { "0_base": [null] } });
}, 30_000);

test("the default worker is extension-free and proves its curated calls (#3658)", async () => {
  const { reported } = await evidence(undefined, ["read", "base"]);
  expect(reported, "PI_DEFAULT_WORKER_IS_EXTENSION_FREE").toEqual({ read: { "0_read": ["worker_read"] }, base: { "0_base": ["host_bridge"] } });
}, 30_000);

/**
 * #2874: with discovery on, a worker whose own loader loaded no extension,
 * reported before its prompt, proves what a curated worker proves. The set
 * cannot change afterwards: only `AgentSession.reload()` reloads it, and a
 * managed worker reaches that only through a loaded extension's `ctx.reload()`.
 */
test("a discovering worker that reports no loaded extension proves what a curated worker proves", async () => {
  const modes = ["read", "edit", "write", "base", "grep", "locked-read", "silent-read", "half-read", "read,grep,read", "forged,base", "read,dup-read,base"];
  const curated = await evidence(false, modes), reported = await evidence(true, modes, 0);
  expect(reported.reported, "PI_REPORTED_EXTENSION_FREE_MATCHES_CURATED").toEqual(curated.reported);
  expect(reported.reported.read, "PI_REPORTED_EXTENSION_FREE_PROVES_READS").toEqual({ "0_read": ["worker_read"] });
}, 60_000);

test("a worker that reports a loaded extension, or reports nothing, proves no call", async () => {
  // One loaded extension can reload the set mid-turn and runs on every tool event.
  const loaded = await evidence(true, ["read", "base"], 1);
  expect(loaded.reported, "PI_LOADED_EXTENSION_PROVES_NOTHING").toEqual({ read: { "0_read": [null] }, base: { "0_base": [null] } });
  // A curated configuration contradicted by its worker's own loader proves nothing either.
  const contradicted = await evidence(false, ["read"], 1);
  expect(contradicted.reported, "PI_CONTRADICTED_CURATED_PROVES_NOTHING").toEqual({ read: { "0_read": [null] } });
  // Discovery on with no report is unproven, as before.
  const silent = await evidence(true, ["read"]);
  expect(silent.reported, "PI_UNREPORTED_DISCOVERY_PROVES_NOTHING").toEqual({ read: { "0_read": [null] } });
}, 60_000);
