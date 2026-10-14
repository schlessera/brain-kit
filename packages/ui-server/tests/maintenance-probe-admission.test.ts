/** A full maintenance budget is a retryable admission fact, not a containment failure. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostMaintenanceTempLimits } from "@schlessera/brain-ui-sdk/internal";
import { reserveMaintenanceTemp } from "../../ui-sdk/src/server/maintenance-temp-budget";
import { createFixtureHostBoundary as createHostBoundary } from "./helpers/native-host-fixture.js";
import { createFixtureMaintenanceHost } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

const roots: string[] = [];
const inputOwners: ReturnType<typeof createFixtureMaintenanceHost>[] = [];
afterEach(() => { for (const owner of inputOwners.splice(0)) owner.cleanup(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-probe-budget-")); roots.push(root);
  const brain = join(root, "brain"), state = join(root, "state"); mkdirSync(brain); mkdirSync(state);
  const statePath = join(state, "ui.db"); writeFileSync(statePath, "Odysseus operational identity");
  return { brain, statePath };
}
test("an uncompleted maintenance probe reports busy without throwing or selecting host execution, then recovers", async () => {
  const f = fixture();
  const held = reserveMaintenanceTemp(hostMaintenanceTempLimits(), { statePath: f.statePath });
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: f.statePath });
  const maintenance = createFixtureMaintenanceHost(f.brain);
  inputOwners.push(maintenance);
  try {
    await boundary.prepare();
    const status = boundary.status();
    expect(status, "BUSY_PROBE_IS_NOT_AVAILABLE").toMatchObject({ available: false, reason: "worker_host_unavailable", hostExecution: "worker" });
    expect("detail" in status && status.detail).toContain("Maintenance temporary storage is busy");
    expect(() => boundary.runSync({ argv: ["/bin/sh", "-c", "printf NOT_ADMITTED"], env: {}, credentials: false, purpose: "busy admission", timeoutMs: 5000, startupView: maintenance.startupView }), "BUSY_COMMAND_NEVER_FALLS_BACK_TO_HOST").toThrow("Maintenance temporary storage is busy");
  } finally { held.release(); }
  await boundary.prepare();
  expect(boundary.status(), "BUSY_PROBE_RECOVERS_WITHOUT_A_MINUTE_CACHE").toMatchObject({ available: true, hostExecution: "worker" });
  const result = boundary.runSync({ argv: ["/bin/sh", "-c", "printf READMITTED"], env: {}, credentials: false, purpose: "admission after release", timeoutMs: 5000, startupView: maintenance.startupView });
  expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout).toBe("READMITTED");
});
