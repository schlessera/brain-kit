import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const status of ["ok", "empty", "unparseable", "not_run"] as const) {
  test(`runScrape persists and reports ${status} through the real adapter`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-report-integration-"));
    try {
      const process = Bun.spawn([
        "bun", join(import.meta.dir, "helpers/report-runner.ts"), status, join(dir, "jobs.db"),
      ], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.report.sources).toHaveLength(1);
      const row = result.report.sources[0];
      expect(row.source).toBe("remoteok");
      expect(row.status).toBe(status);
      expect(row.jobs_found).toBe(status === "ok" ? 1 : 0);
      const failed = status === "unparseable" || status === "not_run";
      expect(row.errors.length > 0).toBe(failed);
      expect(result.report.total_errors).toEqual(row.errors);
      expect(result.run.status).toBe(failed ? "failed" : "completed");
      const cursor = status === "ok" ? "2025-02-01T00:00:00.000Z" : "2025-01-01T00:00:00.000Z";
      expect(result.run.cursor).toBe(cursor);
      expect(result.lastCursor).toBe(cursor);
      expect(result.run.error).toBe(failed ? row.errors.join("; ") : null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
