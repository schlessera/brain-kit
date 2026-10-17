import { createFixtureWorkerStartupView } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { syncPiAuth } from "../../src/session-storage.js";
import {
  runMaintenanceWorker,
  restrictedReadPaths,
  acquireHostCredentialExclusion,
} from "@schlessera/brain-ui-sdk/internal";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
const root = mkdtempSync("/var/tmp/odysseus-pi-auth-maintenance-");
const brain = join(root, "brain"),
  home = join(root, "host");
mkdirSync(brain);
mkdirSync(home);
const entry = join(import.meta.dir, "native-host-auth-maintenance-entry.ts");
const initial = JSON.stringify({
  anthropic: {
    type: "oauth",
    access: "sk-ant-oat-odysseus-expired",
    refresh: "odysseus-refresh-one",
    expires: 0,
  },
});
writeFileSync(join(home, "auth.json"), initial);
writeFileSync(
  join(home, "models.json"),
  JSON.stringify({
    providers: {
      openai: {
        apiKey: "!/usr/bin/printf odysseus-command-key",
        headers: {
          "x-odysseus-home": `!if /usr/bin/touch ${home}/forbidden-write 2>/dev/null; then /usr/bin/printf writable; else /usr/bin/printf readonly; fi`,
        },
      },
    },
  })
);
const startupView = createFixtureWorkerStartupView(brain);
let exclusion:
  | Awaited<ReturnType<typeof acquireHostCredentialExclusion>>
  | undefined;
try {
  exclusion = await acquireHostCredentialExclusion({
    domain: { directory: join(root, "exclusion") },
  });
  const result = await runMaintenanceWorker({
    brainPath: brain,
    startupView,
    tempDomain: { statePath: join(root, "temp-ledger.json") },
    command: [process.execPath, entry],
    credentials: true,
    network: false,
    home,
    env: { PATH: "/usr/bin:/bin", HOME: home },
    readPaths: restrictedReadPaths([process.execPath, entry]),
    timeoutMs: 30000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const observation = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  assert.equal(observation.commandKey, "odysseus-command-key");
  assert.equal(observation.commandHeader, "readonly");
  assert.equal(observation.refreshes, 1);
  assert.equal(observation.scratchRotation, "odysseus-refresh-two");
  assert.equal(observation.hostUnchanged, true);
  assert.equal(observation.directHostAuthRefused, true);
  assert.equal(existsSync(join(home, "forbidden-write")), false);
  assert.equal(readFileSync(join(home, "auth.json"), "utf8"), initial);
  syncPiAuth(home, initial, observation.scratchAuth);
  assert.equal(
    JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).anthropic.refresh,
    "odysseus-refresh-two"
  );
  const { scratchAuth, ...reported } = observation;
  console.log(
    JSON.stringify(
      {
        namespace: readlinkSync("/proc/self/ns/net"),
        copiedStartupTestFixture: true,
        maintenanceNativeAuth: reported,
        hostFilesystemGuardPreserved: true,
        existingCredentialExclusionHeld: true,
        hostRefreshWritebackViaExistingCAS: true,
      },
      null,
      2
    )
  );
} finally {
  startupView.cleanup();
  exclusion?.release();
  rmSync(root, { recursive: true, force: true });
}
