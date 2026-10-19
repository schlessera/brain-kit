/** Synthetic PNGs through the real native hosted bridge; no image provider. */
import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackend } from "../../src/server/backend.js";
import { launchAgentWorker } from "../../src/server/worker-launcher.js";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
const mask = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+p5qgoAAAAABJRU5ErkJggg==", "base64");
const imagePath = ".brain/scratch/raft.png", maskPath = ".brain/scratch/raft-mask.png";

export function prepareNativeScratchMask(brain: string, warm = false): void {
  mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
  writeFileSync(join(brain, imagePath), image);
  if (warm) writeFileSync(join(brain, maskPath), mask);
  writeFileSync(join(brain, ".gitignore"), "node_modules/\n.brain/scratch/\n");
  // A retained old pin survives the actual mask's prune; an unpinned peer does not.
  writeFileSync(join(brain, ".brain/scratch/pinned.png"), image);
  writeFileSync(join(brain, ".brain/scratch/old.png"), image);
  for (const path of ["pinned.png", "old.png"]) utimesSync(join(brain, ".brain/scratch", path), new Date(0), new Date(0));
  mkdirSync(join(brain, ".brain/scratch-pins"), { recursive: true });
  writeFileSync(join(brain, ".brain/scratch-pins/pins.json"), JSON.stringify({ version: 1, ready: true,
    sessions: { "claude:odysseus": [".brain/scratch/pinned.png", imagePath] } }));
}

export function answerNativeScratchMask(frame: Record<string, unknown>, socket: WebSocket): void {
  if (frame.type === "mask_request" && frame.imagePath === imagePath)
    socket.send(JSON.stringify({ type: "mask_response", requestId: frame.requestId, turnId: frame.turnId, maskPng: mask.toString("base64") }));
}

export async function exerciseNativeScratchMask(request: Parameters<AgentBackend["startTurn"]>[0], brain: string, warm = false): Promise<void> {
  try {
    expect(request.workerSandbox, "SCRATCH_MASK_ADMITTED_LIVE_SANDBOX").toMatchObject({ brain, profile: "governed", restricted: false });
    expect(request.workerStartupView, "SCRATCH_MASK_GOVERNED_LIVE_VIEW").toBeUndefined();
    const worker = launchAgentWorker({ brainPath: brain, sandbox: request.workerSandbox, env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      command: ["/bin/sh", "-c", 'id -u; git -c safe.directory=/brain-fixture/brain check-ignore --quiet --no-index -- .brain/scratch'] });
    const timer = setTimeout(() => worker.kill("SIGKILL"), 10000);
    try {
      worker.stdin.end();
      const collect = async (stream: import("node:stream").Readable) => { let text = ""; for await (const chunk of stream) text += chunk.toString(); return text; };
      const [stdout, stderr, code] = await Promise.all([collect(worker.stdout), collect(worker.stderr), worker.exited]);
      expect(code, stderr).toBe(0); expect(stdout, "SCRATCH_MASK_ACTUAL_SEPARATE_AGENT_UID").toBe("21002\n");
      console.log(JSON.stringify({ scratchMaskAgentIgnoreWitness: { code, stdout } }));
    } finally { clearTimeout(timer); }
    const apply = async () => {
      const png = await request.bridge.requestMask!(imagePath, "Mark the raft sail.");
      expect(Buffer.from(png), "SCRATCH_MASK_EXACT_BROWSER_BYTES").toEqual(mask);
      return request.bridge.applyImageMask!({ imagePath, maskPath, png });
    };
    // Spread controls across the existing bounded fresh/warm application phases.
    if (!warm) {
      const result = await apply();
      console.log(JSON.stringify({ nativeScratchMaskApplication: result }));
      expect(result.ok, "SCRATCH_MASK_VALID_IGNORE_REAL_HOSTED_APPLICATION").toBe(true);
      expect(readFileSync(join(brain, maskPath)), "SCRATCH_MASK_EXACT_APPLIED_BYTES").toEqual(mask);
      expect(readFileSync(join(brain, ".brain/scratch/pinned.png")), "SCRATCH_MASK_PRUNE_RETAINS_PIN").toEqual(image);
      expect(existsSync(join(brain, ".brain/scratch/old.png")), "SCRATCH_MASK_PRUNE_REMOVES_UNPINNED_OLD_FILE").toBe(false);
      // This control uses the same live turn and exact browser submission. The
      // host fixture changes inputs between launches, never the admitted worker.
      const ignored = readFileSync(join(brain, ".gitignore"));
      writeFileSync(join(brain, ".gitignore"), "node_modules/\n");
      try {
        const nonignored = await apply();
        expect(nonignored.ok).toBe(false); expect(nonignored.changes).toEqual([]);
        expect(nonignored.message, "SCRATCH_MASK_REAL_NONIGNORED_DIAGNOSTIC").toMatch(/not gitignored as a directory.*brain doctor --fix/s);
        expect(readFileSync(join(brain, maskPath)), "SCRATCH_MASK_NONIGNORED_NO_OVERWRITE").toEqual(mask);
        console.log(JSON.stringify({ nativeScratchMaskNonignored: nonignored }));
      } finally { writeFileSync(join(brain, ".gitignore"), ignored); }
    } else {
      // The captured boot writer has already joined before this live turn.
      // The fixture's final prune join and diagnostics still run afterward.
      const configPath = join(brain, ".git/config"), config = readFileSync(configPath);
      writeFileSync(configPath, "[Odysseus invalid Git configuration\n");
      try {
        const failed = await apply();
        expect(failed.ok).toBe(false); expect(failed.changes).toEqual([]);
        expect(failed.message, "SCRATCH_MASK_REAL_QUERY_FAILURE_DISTINCTION").toContain("Cannot verify");
        expect(failed.message).not.toMatch(/not gitignored|brain doctor|Odysseus/);
        expect(readFileSync(join(brain, maskPath)), "SCRATCH_MASK_QUERY_FAILURE_NO_OVERWRITE").toEqual(mask);
        console.log(JSON.stringify({ nativeScratchMaskFailedQuery: failed }));
      } finally { writeFileSync(configPath, config); }
      const helper = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
      // Missing configuration is a clean unavailable prerequisite. A helper
      // that accepts ownership and then cannot confirm cleanup intentionally
      // retains admission; it is not a clean-unavailability fixture.
      process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = "/usr/local/bin/identity-helper-missing";
      try {
        const unavailable = await apply();
        expect(unavailable.ok).toBe(false); expect(unavailable.changes).toEqual([]);
        expect(unavailable.message, "SCRATCH_MASK_REAL_LAUNCH_FAILURE_DISTINCTION").toContain("Cannot verify");
        expect(unavailable.message).not.toMatch(/not gitignored|brain doctor/);
        expect(readFileSync(join(brain, maskPath)), "SCRATCH_MASK_LAUNCH_FAILURE_NO_OVERWRITE").toEqual(mask);
        console.log(JSON.stringify({ nativeScratchMaskUnavailable: unavailable }));
      } finally { if (helper === undefined) delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER; else process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper; }
    }
  } catch (error) {
    console.log(JSON.stringify({ scratchMaskBackendPrimaryError: { message: error instanceof Error ? error.message : String(error) } }));
    throw error;
  } finally {
    // Leave no fixture pin for later warm/strict cases.
    rmSync(join(brain, ".brain/scratch-pins/pins.json"), { force: true });
  }
}
