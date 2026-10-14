import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrainManagerClient, prepareNativeWorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";

test("a new explicit fixture restores native acquisition after another suite restores all spies", async () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-fixture-restore-"));
  writeFileSync(join(brain, "raft.txt"), "Odysseus fixture input");
  const first = createNativeAppFixture(brain);
  let second: ReturnType<typeof createNativeAppFixture> | undefined;
  try {
    mock.restore();
    second = createNativeAppFixture(brain);
    const view = await prepareNativeWorkerStartupView(brain, createNativeBrainManagerClient(second.nativeBrain));
    try { expect(await Bun.file(join(view.root, "raft.txt")).text(), "EXPLICIT_NATIVE_FIXTURE_REINSTALLED_AFTER_GLOBAL_RESTORE").toBe("Odysseus fixture input"); }
    finally { await view.cleanup(); }
  } finally { await second?.close(); await first.close(); rmSync(brain, { recursive: true, force: true }); }
});
