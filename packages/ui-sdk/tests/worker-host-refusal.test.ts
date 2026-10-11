import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireWorkerHost, WorkerHostError, workerHostBoundary } from "../src/server/worker-launcher.js";

const EXPECTED = "Agent worker boundary unavailable: bubblewrap is missing. Use a verified Linux or qualifying WSL2 host with bubblewrap and unprivileged user namespaces.";

function expectRefusal(brain: string) {
  try { requireWorkerHost(brain); expect.unreachable("host must refuse"); }
  catch (error) {
    expect(error).toBeInstanceOf(WorkerHostError);
    expect((error as Error).message).toBe(EXPECTED);
  }
}

describe("worker host refusal wording", () => {
  test.each(["requirement", "early error", "early generic error"])("formats a %s exactly once", (path) => {
    const probe = spyOn(workerHostBoundary, "probe").mockImplementation(() => {
      if (path === "early error") throw new WorkerHostError("bubblewrap is missing");
      if (path === "early generic error") throw new Error("bubblewrap is missing");
      return { ok: false, requirement: "bubblewrap is missing" };
    });
    try { expectRefusal("/odysseus"); }
    finally { probe.mockRestore(); }
  });

  test("an error inside the real fixture probe retains only its requirement and cleans up", () => {
    const brain = mkdtempSync(join(tmpdir(), "odysseus-worker-refusal-"));
    const which = spyOn(Bun, "which").mockImplementation(() => null);
    try {
      expectRefusal(brain);
      expect(workerHostBoundary.probe(brain)).toEqual({ ok: false, requirement: "bubblewrap is missing" });
      expect(readdirSync(brain)).toEqual([]);
    } finally { which.mockRestore(); rmSync(brain, { recursive: true, force: true }); }
  });
});
