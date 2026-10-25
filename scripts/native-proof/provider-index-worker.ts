/** Real CLI search/rebuild and core capture inside the admitted native worker. */
import { expect } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
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
if (process.argv[4] === "allowed") {
  // A proven allowed recipient (#2695): the folder, history and real index.
  expect(readFileSync(join(brain, "me/oath.md"), "utf8"), "NATIVE_ALLOWED_ROUTE_READS_FOLDER").toContain(sentinel);
  expect(readdirSync(join(brain, ".git")).length, "NATIVE_ALLOWED_ROUTE_SEES_HISTORY").toBeGreaterThan(0);
  const real = statSync(join(brain, ".brain-index"));
  if (process.argv[3] !== "checkpoint") expect(`${real.dev}:${real.ino}`, "NATIVE_ALLOWED_ROUTE_REAL_INDEX").toBe(process.argv[3]);
  const run = Bun.spawnSync([process.execPath, "/repo/packages/core/src/cli/brain.ts", "search", sentinel, "--limit", "50", "--json"],
    { cwd: brain, env: { PATH: "/usr/local/bin:/usr/bin:/bin", BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, `NATIVE_ALLOWED_ROUTE_SEARCH: ${run.stderr.toString()}`).toBe(0);
  const found = JSON.parse(run.stdout.toString());
  expect((Array.isArray(found) ? found : found.results).map((entry: { path: string }) => entry.path), "NATIVE_ALLOWED_ROUTE_SEARCHES_FOLDER").toContain("me/oath.md");
  console.log(JSON.stringify({ nativeProviderAllowedWorker: "pass", profile, uid: process.getuid?.() }));
  process.exit(0);
}
expect(readdirSync(join(brain, "me")), "NATIVE_PROVIDER_FOLDER_EMPTY").toEqual([]);
expect(readdirSync(join(brain, ".git")), "NATIVE_PROVIDER_HISTORY_EMPTY").toEqual([]);
const index = statSync(join(brain, ".brain-index"));
expect(`${index.dev}:${index.ino}`, "NATIVE_PRIVATE_INDEX_MOUNT_IDENTITY").toBe(process.argv[3]);
expect(index.mode & 0o7777, "NATIVE_PRIVATE_INDEX_SETGID_MODE").toBe(0o2770);
expect(statSync(join(brain, ".brain-index/brain.db")).uid, "NATIVE_PRIVATE_INDEX_BUILT_BY_WORKER_UID").toBe(21002);

// The worker's own environment: a strict worker's brain tools read its data tree (#2848).
const spawnCli = (args: string[]) => Bun.spawnSync([process.execPath, "/repo/packages/core/src/cli/brain.ts", ...args, "--json"],
  { cwd: brain, env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
const cli = (args: string[]) => {
  const run = spawnCli(args);
  expect(run.exitCode, `NATIVE_PRIVATE_INDEX_CLI_${args[0]}: ${run.stderr.toString()}`).toBe(0);
  return JSON.parse(run.stdout.toString());
};
/** Every private index file holding the sentinel's folded middle: rows, free pages, FTS segments, WAL. */
const sentinelFiles = () => readdirSync(join(brain, ".brain-index"))
  .filter(name => readFileSync(join(brain, ".brain-index", name)).toString("latin1").toLowerCase().includes(sentinel.toLowerCase().slice(2, -2)));
const [, appliedMarker, appliedPath] = process.argv[4]?.split(":") ?? [];
function search(query: string): string[] {
  const result = cli(["search", query, "--limit", "50"]);
  return (Array.isArray(result) ? result : result.results).map((entry: { path: string }) => entry.path);
}
expect(search(sentinel), "NATIVE_PRIVATE_INDEX_LACKS_MASKED_DOCUMENT").toEqual([]);
expect(search(permitted), "NATIVE_PRIVATE_INDEX_KEEPS_PERMITTED_DOCUMENT").toContain("notes/provider-voyage.md");
expect(sentinelFiles(), "NATIVE_PRIVATE_INDEX_NEVER_HELD_SENTINEL_BYTES").toEqual([]);
// The turn's own application outside the masked folder reached its private
// index before this read (#2846), and nothing masked came with it.
if (appliedMarker) expect(search(appliedMarker), "NATIVE_MASKED_TURN_SEARCH_FINDS_ITS_OWN_APPLICATION").toContain(appliedPath);
// The private index is read-only to the agent; the host keeps it current (#2846).
const rebuild = spawnCli(["index"]);
expect(rebuild.exitCode, "NATIVE_PRIVATE_INDEX_READ_ONLY_TO_THE_AGENT").not.toBe(0);
expect(`${rebuild.stdout}${rebuild.stderr}`, "NATIVE_PRIVATE_INDEX_WRITE_REFUSED").toMatch(/readonly|read-only/i);
expect(search(sentinel), "NATIVE_PRIVATE_INDEX_STILL_FILTERED").toEqual([]);
expect(search(permitted), "NATIVE_PRIVATE_INDEX_KEEPS_PERMITTED_DOCUMENT_AFTER_REFUSAL").toContain("notes/provider-voyage.md");

// Strict turns capture Markdown in their writable scratch area. Use the real
// core ingestion/indexing pipeline with that root and a scratch copy of the
// turn's private database; the private index itself is read-only.
mkdirSync(captureRoot, { mode: 0o2770 });
const scratchIndex = "/tmp/provider-capture-index"; mkdirSync(scratchIndex);
for (const name of readdirSync(join(brain, ".brain-index"))) copyFileSync(join(brain, ".brain-index", name), join(scratchIndex, name));
const context = await initContext({ root: brain }), db = openDatabase(join(scratchIndex, "brain.db"));
try {
  const capture = await ingest({ path: capturePath, type: "note", title: "Odysseus returns to Ithaca", content: captured }, db,
    { root: captureRoot, taxonomy: context.taxonomy });
  expect(capture, "NATIVE_PRIVATE_INDEX_CAPTURE_SUCCEEDS").toMatchObject({ action: "created", path: capturePath, indexed: true });
} finally { db.close(); }
expect(readFileSync(join(captureRoot, capturePath), "utf8"), "NATIVE_CAPTURE_MARKDOWN_IN_WRITABLE_SCRATCH").toContain(captured);
expect(search(captured), "NATIVE_SCRATCH_CAPTURE_NEVER_WRITES_THE_PRIVATE_INDEX").toEqual([]);
expect(search(sentinel), "NATIVE_CAPTURE_NEVER_EXPOSES_MASKED_DOCUMENT").toEqual([]);
expect(sentinelFiles(), "NATIVE_PRIVATE_INDEX_HOLDS_NO_SENTINEL_BYTE_AT_TURN_END").toEqual([]);
console.log(JSON.stringify({ nativeProviderIndexWorker: "pass", profile, uid: process.getuid?.(), capturePath }));
