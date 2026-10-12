import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../src/backend";

test("fresh Pi workers retain the same host session's native read version across ordinary resumed turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-pi-native-turns-")), brain = join(root, "brain");
  mkdirSync(brain); writeFileSync(join(brain, "loom.md"), "Penelope weaves.\n");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  let launched = 0;
  const launch = spyOn(worker, "launchAgentWorker").mockImplementation(() => {
    launched++;
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/native-session-version-worker.ts")], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number>((resolve, reject) => { child.once("exit", code => resolve(code ?? 0)); child.once("error", reject); });
    return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exited, kill: () => child.kill(),
      observeFile: worker.createWorkerFileObserver({ brain, configurationRoot: brain, areas: [] }),
      limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  try {
    const backend = createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions") });
    let sessionId: string | undefined;
    async function turn(prompt: string) {
      const frames: ServerMessage[] = [];
      await backend.startTurn({ sessionId, prompt, signal: new AbortController().signal,
        workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
        bridge: { emit: frame => { frames.push(frame); if ("sessionId" in frame) sessionId ??= frame.sessionId; }, requestPermission: async () => ({ behavior: "allow" }) } });
      return frames;
    }
    await turn("read");
    writeFileSync(join(brain, "loom.md"), "Penelope sleeps.\n");
    const refused = await turn("write");
    expect(readFileSync(join(brain, "loom.md"), "utf8"), "PI_NEXT_TURN_STALE_WRITE_HAS_NO_EFFECT").toBe("Penelope sleeps.\n");
    expect(refused.find(frame => frame.type === "tool_result")).toMatchObject({ isError: true });
    await turn("read");
    const recovered = await turn("write");
    expect(readFileSync(join(brain, "loom.md"), "utf8")).toBe("Athena charts.\n");
    expect(recovered.find(frame => frame.type === "tool_result")).toMatchObject({ isError: false });
    expect(launched, "ONE_REAL_NATIVE_TOOL_PROCESS_PER_TURN").toBe(4);
  } finally {
    launch.mockRestore(); probe.mockRestore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
