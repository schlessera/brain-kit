import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createFixtureWorkerStartupView } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
/** Explicit byte-copy fixture manager, never a product fallback or native filesystem proof. */
export function createNativeHostInputFixture() {
  const store = fs.mkdtempSync("/tmp/odysseus-native-host-"), brain = join(store, "brain");
  fs.mkdirSync(brain); fs.writeFileSync(join(brain, "helper.txt"), "Odysseus initial input");
  const actualStat = fs.statfsSync;
  const stat = spyOn(fs, "statfsSync").mockImplementation(((path: any, options: any) => {
    const value = actualStat(path, options);
    return String(path).startsWith(store) ? { ...value, type: typeof value.type === "bigint" ? 0x9123683en : 0x9123683e } : value;
  }) as typeof fs.statfsSync);
  const checkpoints: string[] = [], released: string[] = [];
  const manager = {
    async checkpoint(id: string) {
      const copied = createFixtureWorkerStartupView(brain), path = join(store, ".brain-native/checkpoints", id);
      fs.mkdirSync(join(store, ".brain-native/checkpoints"), { recursive: true });
      try { fs.renameSync(copied.root, path); } finally { copied.cleanup(); }
      checkpoints.push(id);
      return { id, path, readOnly: true as const, fsid: "00000000-0000-0000-0000-000000000001",
        uuid: "00000000000000000000000000000002", rootId: "256", transaction: "12" };
    },
    async release(id: string) {
      released.push(id); fs.rmSync(join(store, ".brain-native/checkpoints", id), { recursive: true, force: true });
      return { id, state: "deleted" as const };
    },
  };
  const execution = { argv: [process.execPath, "--no-env-file", "-e", 'console.log(require("node:fs").readFileSync("helper.txt","utf8"))'],
    env: {}, credentials: false, gate: "none" as const, purpose: "Odysseus input reader" };
  return { brain, checkpoints, released, manager, execution,
    cleanup() { stat.mockRestore(); fs.rmSync(store, { recursive: true, force: true }); } };
}

