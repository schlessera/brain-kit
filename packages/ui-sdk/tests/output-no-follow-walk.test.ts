/**
 * Both output publishers reach a brain file through the shared no-follow walk
 * (#4766): a symlink planted at an intermediate directory is refused, and a
 * maintenance output path holding a NUL byte is refused before any write.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { ProtectedMaintenanceOutputError } from "../src/server/protected-output-error.js";
import { prepareNativeWorkerOutput } from "../src/server/worker-native-output.js";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import type { NativeStageChange } from "../src/server/native-brain-manager-protocol.js";
import { prepareFixtureWorkerOutput } from "./helpers/worker-startup-view-fixture.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** A brain with one note, and an identical copy outside it that a followed link would reach. */
function brainWithOutside() {
  const store = fs.mkdtempSync("/tmp/odysseus-no-follow-output-"), brain = join(store, "brain"), outside = join(store, "outside");
  cleanup.push(() => fs.rmSync(store, { recursive: true, force: true }));
  for (const directory of [join(brain, "notes"), outside]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, "odysseus.md"), "Odysseus sails");
    fs.chmodSync(join(directory, "odysseus.md"), 0o644);
  }
  return { store, brain, outside };
}
/** Replaces the brain's `notes` directory with a symlink to the outside copy. */
function plantLink(brain: string, outside: string) {
  fs.rmSync(join(brain, "notes"), { recursive: true });
  fs.symlinkSync(outside, join(brain, "notes"));
}

test("maintenance output refuses a NUL path from its protected-output reader and writes nothing", async () => {
  const { brain } = brainWithOutside();
  const output = prepareFixtureWorkerOutput(brain);
  cleanup.push(() => output.cleanup());
  fs.writeFileSync(join(output.output.source, ".env"), "ITHACA_KEY=suitors");
  let refusal: unknown;
  try { output.publish(); } catch (error) { refusal = error; }
  expect(refusal, "PROTECTED_OUTPUT_REFUSED").toBeInstanceOf(ProtectedMaintenanceOutputError);
  await expect((refusal as ProtectedMaintenanceOutputError).read("notes/odys\u0000seus.md", 1024), "NUL_OUTPUT_PATH_REFUSED").rejects.toThrow();
  expect(fs.existsSync(join(brain, ".env")), "NO_WRITE").toBe(false);
  expect(fs.readdirSync(brain).sort()).toEqual(["notes"]);
  expect(fs.readFileSync(join(brain, "notes/odysseus.md"), "utf8")).toBe("Odysseus sails");
});

test("maintenance output refuses a symlink planted at an intermediate directory", () => {
  const { brain, outside } = brainWithOutside();
  const output = prepareFixtureWorkerOutput(brain);
  cleanup.push(() => output.cleanup());
  fs.writeFileSync(join(output.output.source, "notes/odysseus.md"), "Odysseus returns");
  plantLink(brain, outside);
  expect(() => output.publish(), "MAINTENANCE_INTERMEDIATE_LINK_REFUSED").toThrow();
  expect(fs.readFileSync(join(outside, "odysseus.md"), "utf8"), "MAINTENANCE_LINK_TARGET_UNWRITTEN").toBe("Odysseus sails");
});

test("native output refuses a symlink planted at an intermediate directory", async () => {
  const { store, brain, outside } = brainWithOutside();
  const statfs = fs.statfsSync;
  const pretend = spyOn(fs, "statfsSync").mockImplementation(((path: never, options: never) => {
    const value = statfs(path, options);
    return { ...value, type: typeof value.type === "bigint" ? 0x9123683en : 0x9123683e };
  }) as typeof fs.statfsSync);
  cleanup.push(() => pretend.mockRestore());
  const sourceUuid = "11111111111141118111111111111790", uuid = "22222222222242228222222222221790";
  const checkpoints = new Map<string, string>();
  const start = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19]!;
  const manager = {
    async checkpoint(id: string) { const path = join(store, ".brain-native/checkpoints", id); fs.cpSync(brain, path, { recursive: true }); checkpoints.set(id, path);
      return { id, path, sourceUuid, uuid, fsid: "11111111-1111-4111-8111-111111111790", rootId: "257", transaction: "8", readOnly: true as const }; },
    async release(id: string) { fs.rmSync(checkpoints.get(id)!, { recursive: true, force: true }); return { id, state: "deleted" as const }; },
    async prepareStage(id: string, checkpointId: string, allowanceBytes: number) {
      const path = join(store, ".brain-native/stages", id); fs.mkdirSync(path, { recursive: true });
      fs.cpSync(checkpoints.get(checkpointId)!, join(path, "merged"), { recursive: true }); const info = fs.statSync(path, { bigint: true });
      return { id, path, checkpointId, checkpointUuid: uuid, sourceUuid, allowanceBytes, namespacePid: process.pid, namespaceStart: start,
        appUid: process.getuid!(), appGid: process.getgid!(), rootDevice: String(info.dev), rootInode: String(info.ino) };
    },
    async inspectStage() { return { checkpointId: [...checkpoints.keys()][0]!, checkpointUuid: uuid,
      changes: (async function* () { yield { pathHex: Buffer.from("notes/odysseus.md").toString("hex"), kind: "entry" } as NativeStageChange; })(),
      completed: Promise.resolve({ exitCode: 0 as const, bytes: 0 }) }; },
    async releaseStage(id: string) { fs.rmSync(join(store, ".brain-native/stages", id), { recursive: true, force: true }); return { id, state: "deleted" as const }; },
  };
  const view = await prepareNativeWorkerStartupView(brain, manager);
  cleanup.push(() => view.cleanup());
  const output = await prepareNativeWorkerOutput(brain, { startupView: view });
  cleanup.push(() => output.cleanup());
  fs.writeFileSync(join(output.output.source, "notes/odysseus.md"), "Odysseus returns");
  plantLink(brain, outside);
  await expect(output.publish(), "NATIVE_INTERMEDIATE_LINK_REFUSED").rejects.toThrow();
  expect(fs.readFileSync(join(outside, "odysseus.md"), "utf8"), "NATIVE_LINK_TARGET_UNWRITTEN").toBe("Odysseus sails");
});
