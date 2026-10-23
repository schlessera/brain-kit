/** Real CLI search/rebuild and core capture inside the admitted native worker. */
import { expect } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { initContext } from "../../packages/core/src/lib/context.js";
import { openDatabase } from "../../packages/core/src/lib/db.js";
import { ingest } from "../../packages/core/src/lib/ingestion.js";

const brain = "/brain-fixture/brain", profile = process.argv[2];
if (profile !== "strict" && profile !== "governed") throw Error("Unknown provider-index proof profile");
const sentinel = "Zakynthosmarker", permitted = "Phaeacianmarker", captured = "Ithacacapturemarker";
const scratch = profile === "strict" ? "/tmp/brain-worker-areas/scratch" : join(brain, ".brain/scratch");
const captureRoot = join(scratch, `provider-index-${profile}`);
const capturePath = `native-private-index-${profile}.md`;
process.umask(0o002);
expect(process.getuid?.(), "NATIVE_PROVIDER_INDEX_SEPARATE_WORKER_UID").toBe(21002);
expect(process.getgid?.(), "NATIVE_PROVIDER_INDEX_SHARED_GROUP").toBe(21001);
expect(readdirSync(join(brain, "me")), "NATIVE_PROVIDER_FOLDER_EMPTY").toEqual([]);
expect(readdirSync(join(brain, ".git")), "NATIVE_PROVIDER_HISTORY_EMPTY").toEqual([]);
const index = statSync(join(brain, ".brain-index"));
expect(`${index.dev}:${index.ino}`, "NATIVE_PRIVATE_INDEX_MOUNT_IDENTITY").toBe(process.argv[3]);
expect(index.mode & 0o7777, "NATIVE_PRIVATE_INDEX_SETGID_MODE").toBe(0o2770);
expect(statSync(join(brain, ".brain-index/brain.db")).uid, "NATIVE_PRIVATE_INDEX_BUILT_BY_WORKER_UID").toBe(21002);

const cli = (args: string[]) => {
  const run = Bun.spawnSync([process.execPath, "/repo/packages/core/src/cli/brain.ts", ...args, "--json"],
    { cwd: brain, env: { PATH: "/usr/local/bin:/usr/bin:/bin", BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, `NATIVE_PRIVATE_INDEX_CLI_${args[0]}: ${run.stderr.toString()}`).toBe(0);
  return JSON.parse(run.stdout.toString());
};
function search(query: string): string[] {
  const result = cli(["search", query, "--limit", "50"]);
  return (Array.isArray(result) ? result : result.results).map((entry: { path: string }) => entry.path);
}
expect(search(sentinel), "NATIVE_PRIVATE_INDEX_LACKS_MASKED_DOCUMENT").toEqual([]);
expect(search(permitted), "NATIVE_PRIVATE_INDEX_KEEPS_PERMITTED_DOCUMENT").toContain("notes/provider-voyage.md");
expect(readFileSync(join(brain, ".brain-index/brain.db")).includes(Buffer.from(sentinel)),
  "NATIVE_PRIVATE_INDEX_NEVER_HELD_SENTINEL_BYTES").toBe(false);
cli(["index"]);
expect(search(sentinel), "NATIVE_PRIVATE_REBUILD_STILL_FILTERED").toEqual([]);
expect(search(permitted), "NATIVE_PRIVATE_REBUILD_KEEPS_PERMITTED_DOCUMENT").toContain("notes/provider-voyage.md");

// Strict turns capture Markdown in their writable scratch area. Use the real
// core ingestion/indexing pipeline with that root and the mounted turn-private
// database; the CLI's ordinary brain-root capture is intentionally read-only.
mkdirSync(captureRoot, { mode: 0o2770 });
const context = await initContext({ root: brain }), db = openDatabase(context.dbPath);
try {
  const capture = await ingest({ path: capturePath, type: "note", title: "Odysseus returns to Ithaca", content: captured }, db,
    { root: captureRoot, taxonomy: context.taxonomy });
  expect(capture, "NATIVE_PRIVATE_INDEX_CAPTURE_SUCCEEDS").toMatchObject({ action: "created", path: capturePath, indexed: true });
} finally { db.close(); }
expect(readFileSync(join(captureRoot, capturePath), "utf8"), "NATIVE_CAPTURE_MARKDOWN_IN_WRITABLE_SCRATCH").toContain(captured);
expect(search(captured), "NATIVE_PRIVATE_INDEX_CAPTURE_SEARCHABLE").toContain(capturePath);
expect(search(sentinel), "NATIVE_CAPTURE_NEVER_EXPOSES_MASKED_DOCUMENT").toEqual([]);
console.log(JSON.stringify({ nativeProviderIndexWorker: "pass", profile, uid: process.getuid?.(), capturePath }));
