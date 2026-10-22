/** Default composition: ordinary maintenance over a strict worker's persistent server-owned private publication. */
import { expect } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import { launchAgentWorker } from "../src/server/worker-launcher.js";
import type { MaintenanceCommand } from "../src/server/maintenance-worker.js";
import { prepareMaintenanceOutput } from "../../ui-server/src/brain/maintenance-output.js";
import { createRecordingLoggerProvider } from "../../ui-server/src/observability/loggers.js";
import { prepareMaintenanceGit, privateGitSources } from "../../ui-server/src/brain/maintenance-git.js";

const brain = "/brain-fixture/brain", directory = `${brain}/.brain/scratch/private`, file = `${directory}/result.md`;
const text = "Odysseus private stage publication", policy = "*.md odysseus=ithaca\n", sentinel = "Odysseus private server sentinel";
if (process.getuid?.() !== 21001 || process.env.BRAIN_UI_WORKER_IDENTITY_HELPER !== "/usr/local/bin/identity-helper")
  throw Error("PRIVATE_PUBLICATION_TRANSITION_REQUIRES_OWNED_NATIVE_FIXTURE");
const stamp = (path: string) => {
  const info = lstatSync(path);
  return `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.gid}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
};
const original = [directory, file].map(stamp);
function validate() {
  const parent = lstatSync(directory);
  expect(parent.isDirectory(), "STRICT_PUBLICATION_FIXTURE_DIRECTORY_IS_CONCRETE").toBe(true);
  expect(parent.uid, "STRICT_PUBLICATION_FIXTURE_SERVER_OWNER").toBe(21001);
  expect(parent.gid).toBe(21001);
  expect(parent.mode & 0o7777, "STRICT_PUBLICATION_PRIVATE_DIRECTORY_MODE_RETAINED").toBe(0o700);
  {
    const child = lstatSync(file);
    expect(child.isFile(), "STRICT_PUBLICATION_FIXTURE_FILE_IS_CONCRETE").toBe(true);
    expect(child.uid, "STRICT_PUBLICATION_FIXTURE_FILE_SERVER_OWNER").toBe(21001);
    expect(child.gid).toBe(21001);
    expect(child.mode & 0o7777, "STRICT_PUBLICATION_PRIVATE_FILE_MODE_RETAINED").toBe(0o600);
    expect(child.nlink, "STRICT_PUBLICATION_FIXTURE_FILE_IS_UNALIASED").toBe(1);
  }
  expect(readdirSync(directory), "STRICT_PUBLICATION_FIXTURE_EXACT_TWO_NODE_FAMILY").toEqual(["result.md"]);
  expect(readFileSync(file, "utf8"), "STRICT_PUBLICATION_PRIVATE_BYTES_RETAINED").toBe(text);
  expect([directory, file].map(stamp), "STRICT_PUBLICATION_FIXTURE_NODES_UNCHANGED").toEqual(original);
}
async function worker(code: string) {
  const child = launchAgentWorker({ brainPath: brain, sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
    stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2, env: {}, command: ["/usr/bin/python3", "-I", "-S", "-c", code] });
  child.stdin.end();
  const output = new Response(Readable.toWeb(child.stdout as Readable) as unknown as ReadableStream).text();
  const errors = new Response(Readable.toWeb(child.stderr as Readable) as unknown as ReadableStream).text();
  try {
    let status: number;
    try { status = await child.exited; } finally { try { child.state?.close(); } finally { child.turnTemp?.close(); } }
    const [stdout, stderr] = await Promise.all([output, errors]);
    expect(status, stderr).toBe(0); return stdout;
  } finally { await Promise.allSettled([output, errors]); }
}
const manager = createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" });
/** The actual collector composition against a fresh immutable checkpoint. */
async function collect() {
  const logs = createRecordingLoggerProvider(), view = await prepareNativeWorkerStartupView(brain, manager);
  let refused: unknown;
  try {
    const outputs = await prepareMaintenanceOutput(brain, { startupView: view });
    try {
      const command: MaintenanceCommand = { brainPath: brain, command: ["/bin/true"], credentials: false, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } };
      try { await prepareMaintenanceGit(command, outputs, undefined, logs.getLogger("fixture")); } catch (error) { refused = error; }
    } finally { await outputs.cleanup(); }
  } finally { await view.cleanup(); }
  const records = logs.records().map(row => ({ body: String(row.body), attributes: row.attributes }));
  return { refused, records, collector: records.filter(row => row.body === "maintenance Git source collection refused").map(row => row.attributes),
    owner: records.filter(row => row.body === "maintenance Git owner input refused").map(row => row.attributes) };
}

validate();
// Positive: the worker withholds the server-owned private directory, and the
// server reads its policy under its own identity. Nothing is retired.
const positive = await collect();
expect(positive.collector, "STRICT_PRIVATE_PUBLICATION_WORKER_COLLECTOR_ACCEPTS").toEqual([]);
expect(positive.owner, "STRICT_PRIVATE_PUBLICATION_OWNER_READ_ACCEPTS").toEqual([]);
expect(String(positive.refused ?? ""), "STRICT_PRIVATE_PUBLICATION_GIT_SOURCES_FROZEN").not.toContain("Cannot freeze retained concrete Git sources");
validate();
// The actual composed sources: the real collector under the worker identity,
// then the server's owner read of every withheld directory. The strict output
// has no attributes; a second server-owned private directory carries policy
// bytes so the owner read is shown returning operation-required data.
const owned = `${brain}/.brain/scratch/odysseus-owned`;
mkdirSync(owned, { mode: 0o700 }); writeFileSync(`${owned}/.gitattributes`, policy, { mode: 0o600 });
writeFileSync(`${owned}/result.md`, "Penelope private loom\n", { mode: 0o600 });
const frozen = await (async () => {
  const view = await prepareNativeWorkerStartupView(brain, manager);
  try {
    const outputs = await prepareMaintenanceOutput(brain, { startupView: view });
    try { return await privateGitSources({ brainPath: brain, command: ["/bin/true"], credentials: false, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } }, outputs, "/usr/bin/git"); }
    finally { await outputs.cleanup(); }
  } finally { await view.cleanup(); }
})().finally(() => { unlinkSync(`${owned}/.gitattributes`); unlinkSync(`${owned}/result.md`); rmdirSync(owned); });
expect(frozen.withheld, "STRICT_PRIVATE_PUBLICATION_WITHHELD_RESOLVED").toEqual([]);
expect(frozen.attributes.filter(row => row.path.startsWith(".brain/")), "ACTUAL_SERVER_OWNED_PRIVATE_POLICY_FROZEN")
  .toEqual([{ path: ".brain/scratch/odysseus-owned/.gitattributes", data: policy }]);
expect(JSON.stringify(frozen), "PRIVATE_CONTENT_BYTES_NEVER_COLLECTED").not.toMatch(/Odysseus private stage publication|Penelope private loom/);
validate();

// Identity guard: a worker-owned directory the worker itself cannot search is
// withheld, and the server refuses it even though its group could read it.
const foreign = await worker(String.raw`import json,os
p=${JSON.stringify(`${brain}/odysseus-foreign`)}
os.mkdir(p,0o700)
open(p+"/.gitattributes","w").write("*.md circe=aeaea\n")
os.chmod(p+"/.gitattributes",0o640)
os.chmod(p,0o070)
i=os.lstat(p)
print(json.dumps({"uid":os.getuid(),"owner":i.st_uid,"gid":i.st_gid,"mode":i.st_mode&0o7777}))`);
try {
  expect(JSON.parse(foreign), "FOREIGN_WORKER_DIRECTORY_REAL_IDENTITY").toEqual({ uid: 21002, owner: 21002, gid: 21001, mode: 0o070 });
  const refused = await collect();
  expect(String(refused.refused), "SERVER_OWNER_READ_FOREIGN_REFUSES").toContain("Cannot freeze retained concrete Git sources");
  expect(refused.collector, "FOREIGN_WORKER_DIRECTORY_IS_WITHHELD").toEqual([]);
  expect(refused.owner, "SERVER_OWNER_READ_REFUSES_FOREIGN_WORKER_DIRECTORY").toEqual([{ "maintenance.git.phase": "owner", "maintenance.git.errorClass": "Error",
    "maintenance.git.errno": "unknown", "maintenance.git.rootClass": "other", "maintenance.git.depth": 1, "maintenance.git.uid": 21002,
    "maintenance.git.gid": 21001, "maintenance.git.mode": 0o070, "maintenance.git.type": "directory" }]);
  expect(JSON.stringify(refused.records), "FOREIGN_WORKER_POLICY_NEVER_READ").not.toContain("circe");
} finally {
  await worker(String.raw`import os
p=${JSON.stringify(`${brain}/odysseus-foreign`)}
os.chmod(p,0o700);os.unlink(p+"/.gitattributes");os.rmdir(p)`);
}
validate();

// Secret denial: a server-owned private alias to the server's own sentinel is
// refused without following it.
const alias = `${brain}/.brain/scratch/odysseus-alias`;
mkdirSync(alias, { mode: 0o700 }); symlinkSync("/identity-server-private/sentinel", `${alias}/.gitattributes`);
try {
  const refused = await collect();
  expect(String(refused.refused), "SERVER_OWNER_READ_ALIAS_REFUSES").toContain("Cannot freeze retained concrete Git sources");
  expect(refused.owner.map(row => [row["maintenance.git.phase"], row["maintenance.git.uid"], row["maintenance.git.type"]]),
    "SERVER_OWNER_READ_REFUSES_SECRET_ALIAS").toEqual([["owner", 21001, "symlink"]]);
  expect(JSON.stringify(refused.records) + String(refused.refused), "SERVER_SECRET_NEVER_READ_THROUGH_OWNER_PATH").not.toContain(sentinel);
} finally { unlinkSync(`${alias}/.gitattributes`); rmdirSync(alias); }
validate();
console.log(JSON.stringify({ strictPrivatePublicationMaintenance: { serverOwner: 21001, directoryMode: 0o700, fileMode: 0o600,
  nodesRetained: 2, collectorWithheld: true, ownerRead: "accepted", frozenPolicy: "ithaca",
  refusals: ["foreign-worker-directory", "server-secret-alias"] } }));
