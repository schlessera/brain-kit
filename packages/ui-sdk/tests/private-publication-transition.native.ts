/** Default-composition transition from the strict private-publication negative input. */
import { expect } from "bun:test";
import { lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import { prepareMaintenanceOutput } from "../../ui-server/src/brain/maintenance-output.js";
import { prepareMaintenanceGit } from "../../ui-server/src/brain/maintenance-git.js";

const brain = "/brain-fixture/brain", directory = `${brain}/.brain/scratch/private`, file = `${directory}/result.md`;
const text = "Odysseus private stage publication";
if (process.getuid?.() !== 21001 || process.env.BRAIN_UI_WORKER_IDENTITY_HELPER !== "/usr/local/bin/identity-helper")
  throw Error("PRIVATE_PUBLICATION_TRANSITION_REQUIRES_OWNED_NATIVE_FIXTURE");
const stamp = (path: string) => {
  const info = lstatSync(path);
  return `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.gid}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
};
const originalDirectory = stamp(directory), originalFile = stamp(file);
function validate() {
  const parent = lstatSync(directory), child = lstatSync(file);
  expect(parent.isDirectory(), "STRICT_PUBLICATION_FIXTURE_DIRECTORY_IS_CONCRETE").toBe(true);
  expect(child.isFile(), "STRICT_PUBLICATION_FIXTURE_FILE_IS_CONCRETE").toBe(true);
  expect(parent.uid, "STRICT_PUBLICATION_FIXTURE_SERVER_OWNER").toBe(21001);
  expect(child.uid, "STRICT_PUBLICATION_FIXTURE_FILE_SERVER_OWNER").toBe(21001);
  expect(parent.gid).toBe(21001); expect(child.gid).toBe(21001);
  expect(parent.mode & 0o7777, "STRICT_PUBLICATION_PRIVATE_DIRECTORY_MODE_RETAINED").toBe(0o700);
  expect(child.mode & 0o7777, "STRICT_PUBLICATION_PRIVATE_FILE_MODE_RETAINED").toBe(0o600);
  expect(child.nlink, "STRICT_PUBLICATION_FIXTURE_FILE_IS_UNALIASED").toBe(1);
  expect(readdirSync(directory), "STRICT_PUBLICATION_FIXTURE_EXACT_TWO_NODE_FAMILY").toEqual(["result.md"]);
  expect(readFileSync(file, "utf8"), "STRICT_PUBLICATION_PRIVATE_BYTES_RETAINED").toBe(text);
  expect(stamp(directory), "STRICT_PUBLICATION_FIXTURE_DIRECTORY_UNCHANGED").toBe(originalDirectory);
  expect(stamp(file), "STRICT_PUBLICATION_FIXTURE_FILE_UNCHANGED").toBe(originalFile);
}
validate();
const manager = createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" });
const view = await prepareNativeWorkerStartupView(brain, manager);
const failures: unknown[] = [], originalError = console.error;
let refused: unknown;
try {
  const outputs = await prepareMaintenanceOutput(brain, { startupView: view });
  try {
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string") { try { failures.push(JSON.parse(args[0])); } catch {} }
      originalError(...args);
    };
    try { await prepareMaintenanceGit({ brainPath: brain, command: ["/bin/true"], credentials: false,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" } }, outputs); } catch (error) { refused = error; }
    finally { console.error = originalError; }
  } finally { await outputs.cleanup(); }
} finally { console.error = originalError; await view.cleanup(); }
expect(String(refused), "STRICT_SERVER_PRIVATE_PUBLICATION_COLLECTOR_REFUSES").toContain("Cannot freeze retained concrete Git sources");
expect(failures, "STRICT_SERVER_PRIVATE_PUBLICATION_REAL_ATTRS_EACCES").toContainEqual({ maintenanceGitSourceFailure: {
  exitCode: 1, killed: false, phase: "attrs", errorClass: "Error", errno: "EACCES",
  attrs: { rootClass: ".brain", depth: 3, uid: 65534, gid: 21001, mode: 0o700, type: "directory" },
} });
validate();
// This two-node negative fixture has completed its publication and refusal proof.
// No recursive delete, permission rewrite or unknown-name exclusion is allowed.
unlinkSync(file); rmdirSync(directory);
expect(lstatSync(directory, { throwIfNoEntry: false }), "STRICT_PUBLICATION_NEGATIVE_FIXTURE_RETIRED").toBeUndefined();
console.log(JSON.stringify({ strictPrivatePublicationTransition: { serverOwner: 21001, directoryMode: 0o700, fileMode: 0o600,
  collectorRefused: "attrs/EACCES", exactOwnedNodesRetired: 2, otherInputsUnchanged: true } }));
