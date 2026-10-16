import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
installFixtureNativeStartupViews();
/** Ordinary edge/configuration proof only; no namespace worker or external transport runs. */
import { expect, spyOn, test } from "bun:test";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { createGovernedTurns } from "../src/brain/governed-turn";
import type { HostExecution } from "../src/brain/host-execution";
import { resolveCronConfig, resolveServerConfig } from "../src/config/env";
import { emitEnvironment } from "../src/cron/emit";
import { maintenanceLaunch } from "@schlessera/brain-ui-sdk/internal";
import { syncTransportCommand } from "../src/brain/sync-mirror";
import { createHostBoundary } from "../src/brain/host-boundary";

test("server and cron resolve independent defaults and the same maintenance overrides", () => {
  const expected = { allowanceBytes: 268435456, budgetBytes: 268435456 };
  expect(resolveServerConfig({ MAX_CONCURRENT_SESSIONS: "99" }).maintenanceTemp).toEqual(expected);
  expect(resolveCronConfig({ MAX_CONCURRENT_SESSIONS: "99" }).maintenanceTemp).toEqual(expected);
  const env = { BRAIN_UI_MAINTENANCE_TEMP_BYTES: "8388608", BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES: "16777216" };
  const server = resolveServerConfig(env), cron = resolveCronConfig(env);
  expect(server.maintenanceTemp).toEqual({ allowanceBytes: 8388608, budgetBytes: 16777216 });
  expect(cron.maintenanceTemp).toEqual(server.maintenanceTemp);
  expect(cron.childEnv).not.toHaveProperty("BRAIN_UI_MAINTENANCE_TEMP_BYTES");
  expect(cron.controlEnv).toMatchObject(env);
  expect(emitEnvironment(env)).toContain('BRAIN_UI_MAINTENANCE_TEMP_BYTES="8388608"');
  expect(emitEnvironment(env)).toContain('BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES="16777216"');
});

test("invalid maintenance configuration refuses both edges before any command", () => {
  for (const resolver of [resolveServerConfig, resolveCronConfig]) {
    for (const name of ["BRAIN_UI_MAINTENANCE_TEMP_BYTES", "BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES"]) {
      for (const value of ["0", "-4096", "4097", "1e6", "256MiB"]) expect(() => resolver({ [name]: value })).toThrow(name);
    }
    expect(() => resolver({ BRAIN_UI_MAINTENANCE_TEMP_BYTES: "536870912" })).toThrow("cover at least one");
  }
  expect(() => createHostBoundary({ brainPath: "/tmp", maintenanceTemp: { allowanceBytes: 4097, budgetBytes: 8192 } })).toThrow("BRAIN_UI_MAINTENANCE_TEMP_BYTES");
});

test("configured Git transport retains its separate envelope and maintenance allowance", () => {
  const tempLimits = { allowanceBytes: 8388608, budgetBytes: 16777216 };
  const command = syncTransportCommand({ brain: "/tmp", mirror: "/tmp/odysseus-mirror", remote: "https://github.com/odysseus/ithaca.git", env: {}, args: ["fsck"], tempLimits, tempDomain: {statePath:"/tmp/odysseus-ui.db"} });
  expect(command.tempLimits, "SYNC_TRANSPORT_RETAINS_MAINTENANCE_LIMITS").toEqual(tempLimits);
  expect(command.tempDomain,"SYNC_TRANSPORT_RETAINS_SHARED_STATE_IDENTITY").toEqual({statePath:"/tmp/odysseus-ui.db"});
  const launch = maintenanceLaunch(command);
  expect(launch.maintenance).toBeUndefined();
  expect(launch.transport).toMatchObject({ mirror: "/tmp/odysseus-mirror", tempBytes: 8388608 });
  expect(launch.env.TMPDIR).toBe("/tmp");
  expect(launch.env.XDG_STATE_HOME).toBe("/tmp/brain-maintenance-state");
});


test("the host boundary exposes the same trusted settings to existing hosted helper entry paths",()=>{
 const tempLimits={allowanceBytes:8388608,budgetBytes:16777216};
 const boundary=createHostBoundary({brainPath:"/tmp/odysseus-brain",dbPath:"/tmp/odysseus-state/ui.db",maintenanceTemp:tempLimits});
 expect(boundary.maintenance).toEqual({tempLimits,tempDomain:{statePath:"/tmp/odysseus-state/ui.db"},maskPaths:["/tmp/odysseus-state"]});
});

test("hosted turn admission forwards maintenance identity before backend startup", async () => {
  const maintenance = { tempLimits: { allowanceBytes: 8388608, budgetBytes: 16777216 },
    tempDomain: { statePath: "/tmp/odysseus-state/ui.db" }, maskPaths: ["/tmp/odysseus-state"] };
  let released = 0;
  const execution = { boundary: { maintenance, prepare: async () => ({ available: true }), governed: () => ({ available: true }) },
    gate: () => ({ acquire: async () => ({ release: () => { released++; } }) }),
    manifests: () => ({}) } as unknown as HostExecution;
  const root = mkdtempSync(join(tmpdir(), "odysseus-maintenance-config-")), brain = join(root,"brain"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain,root);
  const prepare = spyOn(worker, "prepareWorkerSandbox").mockReturnValue({ brain, restricted: false, profile: "strict", areas: [], scratchAliasesRemoved: [] } as worker.WorkerSandbox);
  try {
    const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, execution,
      profile: "strict", maskPaths: maintenance.maskPaths, index: async () => {}, report: () => {} });
    const hold = await turns.begin("odysseus-turn", new AbortController().signal);
    expect(prepare.mock.calls[0]?.[1]?.maintenance, "HOSTED_TURN_SHARED_MAINTENANCE_ADMISSION").toMatchObject(maintenance);
    expect(prepare.mock.calls[0]?.[1]?.maintenance?.startupView).toBe(hold.startupView);
    await hold.end();
    expect(released).toBe(1);
    await turns.close();
  } finally { prepare.mockRestore(); await native.close(); rmSync(root,{recursive:true,force:true}); }
});
