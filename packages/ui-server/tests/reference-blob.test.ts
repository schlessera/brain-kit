import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createReferenceTransport } from "../src/brain/reference-transport";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reference-blob-")); roots.push(root);
  const environment = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.test", GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.test",
    GIT_AUTHOR_DATE: "2026-07-12T12:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T12:00:00Z" };
  function git(...args: string[]) {
    const child = Bun.spawnSync(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env: environment });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    return child.stdout.toString().trim();
  }
  git("init", "--quiet", "-b", "main");
  const bytes = Buffer.from([0, 255, 10, 240, 159, 154, 162, 128, 13, 10, 65]);
  writeFileSync(join(root, "chart.bin"), bytes);
  writeFileSync(join(root, "star*.md"), "The Sirens sing.\n");
  writeFileSync(join(root, "star-other.md"), "A different chart.\n");
  writeFileSync(join(root, ":(glob)star.md"), "A literal Git path.\n");
  mkdirSync(join(root, "notes")); writeFileSync(join(root, "notes/empty.md"), "");
  symlinkSync("chart.bin", join(root, "alias"));
  git("add", "."); git("commit", "--quiet", "-m", "Ithaca charts");
  const commit = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
  const launches: Parameters<NonNullable<Parameters<typeof createReferenceTransport>[0]["run"]>>[0][] = [];
  // Actual installed Git and Python execute the production program. This
  // direct runner does not claim maintenance-worker or native isolation.
  const run: NonNullable<Parameters<typeof createReferenceTransport>[0]["run"]> = async input => {
    launches.push(input);
    const child = Bun.spawn([...input.command], { env: input.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const abort = () => child.kill("SIGKILL"); input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode, killed: input.signal?.aborted ?? false };
    } finally { input.signal?.removeEventListener("abort", abort); }
  };
  const transport = createReferenceTransport({ brainPath: root, run });
  const read = (path: string, offset = 0, maximum = 65_536) => {
    expect(typeof transport.readBlob, "IMMUTABLE_REFERENCE_BLOB_READ_IMPLEMENTED").toBe("function");
    return transport.readBlob!({ root, commit, tree, path, offset, maximum });
  };
  return { root, bytes, git, commit, tree, launches, run, transport, read };
}

test("an immutable binary range is bound to its original Git blob, despite checkout edits and origin changes", async () => {
  const f = fixture(), blob = f.git("rev-parse", "HEAD:chart.bin");
  writeFileSync(join(f.root, "chart.bin"), "Different worktree bytes.");
  f.git("remote", "add", "origin", "https://github.com/poseidon/sea.git");
  const result = await f.read("chart.bin", 2, 7);
  expect(Buffer.from(result.bytes), "IMMUTABLE_REFERENCE_RANGE_BYTES").toEqual(f.bytes.subarray(2, 9));
  expect(result).toMatchObject({ blob, mode: "100644", tree: f.tree, totalBytes: f.bytes.length, offset: 2, length: 7,
    digest: createHash("sha256").update(f.bytes.subarray(2, 9)).digest("hex") });
  expect(f.launches.length).toBe(1);
  expect(f.launches[0]!.credentials, "IMMUTABLE_REFERENCE_READ_NO_CREDENTIALS").toBe(false);
  expect(f.launches[0]!.transport?.network, "IMMUTABLE_REFERENCE_READ_OFFLINE").toBe(false);
  expect(Object.keys(f.launches[0]!.env).some(key => /TOKEN|SECRET|PASSWORD/.test(key))).toBe(false);
});

test("Git pathspec metacharacters select exactly the literal immutable path", async () => {
  const f = fixture();
  expect(Buffer.from((await f.read("star*.md")).bytes).toString()).toBe("The Sirens sing.\n");
  expect(Buffer.from((await f.read(":(glob)star.md")).bytes).toString()).toBe("A literal Git path.\n");
});

test("a regular executable blob and an empty blob retain exact object mode and byte bounds", async () => {
  const f = fixture();
  chmodSync(join(f.root, "star*.md"), 0o755); f.git("add", "star*.md"); f.git("commit", "--quiet", "-m", "Make the chart executable");
  const commit = f.git("rev-parse", "HEAD"), tree = f.git("rev-parse", "HEAD^{tree}");
  expect((await f.transport.readBlob!({ root: f.root, commit, tree, path: "star*.md", offset: 0, maximum: 1024 })).mode).toBe("100755");
  const empty = await f.read("notes/empty.md");
  expect(empty.length).toBe(0); expect(empty.totalBytes).toBe(0);
  expect(Buffer.from(empty.bytes)).toEqual(Buffer.alloc(0));
  expect(empty.digest).toBe(createHash("sha256").update("").digest("hex"));
  expect((await f.read("chart.bin", f.bytes.length)).length).toBe(0);
});

test("symlinks, directories, gitlinks and absent entries are never immutable regular blob reads", async () => {
  const f = fixture();
  for (const path of ["alias", "alias/child", "notes", "absent.md"])
    await expect(f.read(path), `IMMUTABLE_REFERENCE_NON_BLOB_REFUSED:${path}`).rejects.toMatchObject({ reason: "invalid" });
  expect(Buffer.from((await f.read("star*.md")).bytes).toString(), "IMMUTABLE_REFERENCE_OTHER_BLOB_REMAINS_USABLE").toBe("The Sirens sing.\n");
  f.git("update-index", "--add", "--cacheinfo", `160000,${f.commit},foreign`); f.git("commit", "--quiet", "-m", "Record a foreign submodule");
  await expect(f.transport.readBlob!({ root: f.root, commit: f.git("rev-parse", "HEAD"), tree: f.git("rev-parse", "HEAD^{tree}"), path: "foreign", offset: 0, maximum: 1024 }),
    "IMMUTABLE_REFERENCE_GITLINK_REFUSED").rejects.toMatchObject({ reason: "invalid" });
});

test("invalid relative paths and numeric bounds are refused before launching a worker", async () => {
  const f = fixture();
  for (const path of ["", "/chart.bin", "../chart.bin", "notes/../chart.bin", "notes//empty.md", ".git/config", "chart.bin\u0000other", "notes\\empty.md", "\ud800.md"])
    await expect(f.read(path)).rejects.toMatchObject({ reason: "invalid" });
  for (const [offset, maximum] of [[-1, 1], [0.5, 1], [0, 0], [0, 65_537], [Number.MAX_SAFE_INTEGER + 1, 1]])
    await expect(f.read("chart.bin", offset, maximum)).rejects.toMatchObject({ reason: "invalid" });
  expect(f.launches, "IMMUTABLE_REFERENCE_INVALID_INPUT_NO_WORKER").toHaveLength(0);
});

test("a different expected tree and corrupted blob objects refuse without returning bytes", async () => {
  const f = fixture();
  await expect(f.transport.readBlob!({ root: f.root, commit: f.commit, tree: "a".repeat(40), path: "chart.bin", offset: 0, maximum: 1024 }),
    "IMMUTABLE_REFERENCE_TREE_MISMATCH").rejects.toMatchObject({ reason: "unavailable" });
  const blob = f.git("rev-parse", "HEAD:chart.bin"), object = join(f.root, ".git/objects", blob.slice(0, 2), blob.slice(2));
  chmodSync(object, 0o644); writeFileSync(object, deflateSync(Buffer.from("blob 6\u0000forged")));
  await expect(f.read("chart.bin"), "IMMUTABLE_REFERENCE_OBJECT_HASH_CHECK").rejects.toMatchObject({ reason: "unavailable" });
});

test("oversized blobs refuse before their body is returned", async () => {
  const f = fixture();
  const allowed = Buffer.alloc(4 * 1024 * 1024, 0xa5);
  writeFileSync(join(f.root, "bounded.bin"), allowed);
  writeFileSync(join(f.root, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
  f.git("add", "bounded.bin", "large.bin"); f.git("commit", "--quiet", "-m", "Add bounded charts");
  const commit = f.git("rev-parse", "HEAD"), tree = f.git("rev-parse", "HEAD^{tree}");
  const boundary = await f.transport.readBlob!({ root: f.root, commit, tree, path: "bounded.bin", offset: 0, maximum: 65_536 });
  expect(Buffer.from(boundary.bytes), "IMMUTABLE_REFERENCE_FULL_BOUND_ACCEPTED").toEqual(allowed.subarray(0, 65_536));
  expect(boundary).toMatchObject({ totalBytes: allowed.length, length: 65_536 });
  await expect(f.transport.readBlob!({ root: f.root, commit, tree, path: "large.bin", offset: 0, maximum: 1 }),
    "IMMUTABLE_REFERENCE_BLOB_BOUND").rejects.toMatchObject({ reason: "capacity" });
});

test("a cancelled read launches nothing, and malformed worker byte evidence is refused", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(f.transport.readBlob!({ root: f.root, commit: f.commit, tree: f.tree, path: "chart.bin", offset: 0, maximum: 1024, signal: controller.signal })).rejects.toBeDefined();
  expect(f.launches, "IMMUTABLE_REFERENCE_CANCELLED_NO_WORKER").toHaveLength(0);
  const late = new AbortController();
  const pending = { root: f.root, commit: f.commit, tree: f.tree, path: "chart.bin", offset: 0, maximum: 1024, signal: late.signal };
  const cancelled = createReferenceTransport({ brainPath: f.root, run: async input => {
    const result = await f.run(input); late.abort(); pending.signal = new AbortController().signal; return result;
  } });
  await expect(cancelled.readBlob!(pending),
    "IMMUTABLE_REFERENCE_CANCELLED_RESULT_WITHHELD").rejects.toBeDefined();
  const transport = createReferenceTransport({ brainPath: f.root, run: async input => {
    const result = await f.run(input), value = JSON.parse(result.stdout); value.digest = "0".repeat(64);
    return { ...result, stdout: JSON.stringify(value) };
  } });
  await expect(transport.readBlob!({ root: f.root, commit: f.commit, tree: f.tree, path: "chart.bin", offset: 0, maximum: 1024 }),
    "IMMUTABLE_REFERENCE_RETURNED_DIGEST_CHECK").rejects.toMatchObject({ reason: "unavailable" });
});
