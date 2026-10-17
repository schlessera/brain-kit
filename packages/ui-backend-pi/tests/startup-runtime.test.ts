import { expect, test } from "bun:test";
import { join } from "node:path";

test("offline Pi startup reports new/resumed phases and preserves private per-turn state", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/measure-startup.ts"), "--runs=1"], {
    cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err || out).toBe(0);
  const receipt = JSON.parse(out).receipts[0];
  expect(receipt.archiveSessions).toBe(128);
  expect(receipt.selectedTranscriptBytes).toBeGreaterThan(256 * 1024);
  const [fresh, resumed] = receipt.rows;
  expect(fresh.kind).toBe("new"); expect(resumed.kind).toBe("resumed");
  expect(fresh.sessionId).toBe(resumed.sessionId);
  expect(fresh.workerPid, "PI_STARTUP_DISTINCT_WORKERS").not.toBe(resumed.workerPid);
  // Namespace inode numbers may be recycled after the preceding worker exits.
  // Distinct host PIDs plus the absent previous turn's marker prove the reset.
  for (const row of receipt.rows) {
    expect(row.identity, "PI_STARTUP_PRIVATE_HOME_TEMP_RESET").toMatchObject({ homeReadOnly: true, scratch: "/tmp/brain-worker-scratch", prior: false });
    expect(row.phases.filter((p: any) => p.phase).map((p: any) => p.phase)).toEqual(["preparation", "spawn", "worker_started", "resources", "session", "initialize"]);
    for (const phase of row.phases) {
      expect(phase.elapsedMs).toBeGreaterThanOrEqual(0);
      if (phase.phase) expect(phase.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(row.providerRequestMs).toBeGreaterThan(row.firstFrameMs);
    expect(row.firstFrameMs).toBeGreaterThan(row.phases.at(-1).elapsedMs);
  }
});
