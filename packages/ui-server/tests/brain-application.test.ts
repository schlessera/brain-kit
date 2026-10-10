import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, statSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeyedLock, BRAIN_APPLICATION_MAX_BYTES, type BrainApplicationInput, type BrainApplicationResult, type BrainApplicationOperation } from "@schlessera/brain-ui-sdk/server";
import { keylessEnv } from "../../core/tests/cli-harness.js";
import { contentHash, createBrainApplication, readBrainApplicationBase } from "../src/brain/application.js";

const operations: BrainApplicationOperation[] = ["add", "update", "archive", "write", "edit", "staged"];
let root: string;
let signal: AbortController;
let receipts: BrainApplicationResult[];
let authorized: boolean;
let beforeCommit: (() => void) | undefined;
let approved: boolean;
let approvals: BrainApplicationInput[];
let allowed: BrainApplicationOperation[];
let available: BrainApplicationOperation[];
const lock = createKeyedLock();
const path = "notes/raft.md";
const raw = "---\ntitle: Raft\ntype: note\nstatus: active\n---\nOdysseus repairs the raft.\n";
const policyPath = "context/policies/crew.md";
const policy = "---\ntype: policy\n---\nAthena reviews crew decisions.\n";
const request = (input: unknown) => ({ principalId: "odysseus", turnId: "turn-raft", input: input as BrainApplicationInput });
const write = (target = path, content = "Odysseus sails.\n", expectedBaseHash: string | null = contentHash(raw)) => ({ operation: "write" as const, path: target, content, expectedBaseHash });
function application() {
  return createBrainApplication({ root, principalId: "odysseus", turnId: "turn-raft", signal: signal.signal,
    isAuthorized: () => authorized, policy: { autoAllowed: allowed, available, lock },
    approve: async input => { approvals.push(input); return approved; }, record: result => receipts.push(result),
    beforeCommit: () => beforeCommit?.(),
  });
}
function policyUnchanged() {
  expect(readFileSync(join(root, policyPath), "utf8")).toBe(policy);
  expect(readdirSync(join(root, "context/policies"))).toEqual(["crew.md"]);
}
async function denied(input: unknown, code: string) {
  const result = await application()(request(input));
  expect(result.ok).toBe(false);
  expect(result.code).toBe(code);
  expect(result.changes).toEqual([]);
  expect(receipts).toEqual([result]);
  policyUnchanged();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-application-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  // This test's index starts disposable and is rebuilt by successful applications.
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, path), raw);
  writeFileSync(join(root, policyPath), policy);
  signal = new AbortController(); receipts = []; authorized = true; beforeCommit = undefined;
  allowed = [...operations]; available = [...operations]; approved = true; approvals = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("server-owned application boundary", () => {
  test.each(["context/policies/crew.md", "context", "context/policies", "CONTEXT/POLICIES/crew.md", "context/ｐｏｌｉｃｉｅｓ/crew.md"])("policy and ancestor denial: %s", async target => {
    await denied(write(target, "Untrusted change", target === policyPath ? contentHash(policy) : null), "policy_denied");
  });
  test("traversal alias refuses without touching policy", async () => {
    await denied(write("notes/../context/policies/crew.md", "Untrusted change", contentHash(policy)), "invalid_target");
  });
  test("symlink file alias refuses without touching policy", async () => {
    symlinkSync(join(root, policyPath), join(root, "notes/alias.md"));
    await denied(write("notes/alias.md", "Untrusted change", contentHash(policy)), "alias_denied");
  });
  test("symlink directory alias refuses without touching policy", async () => {
    symlinkSync(join(root, "context/policies"), join(root, "policy-alias"));
    await denied(write("policy-alias/crew.md", "Untrusted change", contentHash(policy)), "alias_denied");
  });
  test("hardlink alias refuses without touching policy", async () => {
    linkSync(join(root, policyPath), join(root, "notes/alias.md"));
    await denied(write("notes/alias.md", "Untrusted change", contentHash(policy)), "alias_denied");
  });
  test("target swapped to a symlink after validation refuses", async () => {
    beforeCommit = () => { rmSync(join(root, path)); symlinkSync(join(root, policyPath), join(root, path)); };
    await denied(write(), "alias_denied");
  });
  test("directory topology swap refuses through pinned descriptors", async () => {
    beforeCommit = () => { renameSync(join(root, "notes"), join(root, "old-notes")); symlinkSync(join(root, "context/policies"), join(root, "notes")); };
    await denied(write(), "topology_changed");
    expect(readFileSync(join(root, "old-notes/raft.md"), "utf8")).toBe(raw);
    expect(readdirSync(join(root, "old-notes")).some(name => name.startsWith(".brain-apply"))).toBe(false);
  });
  test("payload over the bound refuses", async () => {
    await denied(write(path, "x".repeat(BRAIN_APPLICATION_MAX_BYTES)), "payload_too_large");
  });
  test("unsupported operation and command text refuse", async () => {
    await denied({ operation: "shell", command: "brain add raft" }, "invalid_request");
  });
  test("unsupported host refuses before opening a target", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
      await denied(write(), "unsupported_host");
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });
  test("a command in the application envelope refuses", async () => {
    const result = await application()({ ...request(write()), command: "brain add raft" } as never);
    expect(result.ok).toBe(false); expect(result.code).toBe("invalid_request");
    expect(result.changes).toEqual([]); policyUnchanged();
  });
  test("generated capture content also obeys the byte bound", async () => {
    // One long lexical token becomes a tag in the ordinary deterministic
    // classifier. Its generated frontmatter makes the final proposal larger
    // than the input request, which itself stays within the request bound.
    await denied({ operation: "add", content: "raft".repeat(140_000), title: "Raft", type: "note" }, "payload_too_large");
  });
  test("unsupported file kind refuses", async () => {
    await denied(write("notes/raft.ts", "Untrusted code", null), "unsupported_kind");
  });
  test("directory file kind refuses", async () => {
    mkdirSync(join(root, "notes/directory.md"));
    await denied(write("notes/directory.md", "Wrong kind", null), "alias_denied");
  });
  test("FIFO file kind refuses without opening a privileged writer", async () => {
    const fifo = join(root, "notes/fifo.md");
    const made = Bun.spawnSync(["mkfifo", fifo], { stdout: "ignore", stderr: "pipe" });
    expect(made.exitCode).toBe(0);
    await denied(write("notes/fifo.md", "Odysseus rows.", contentHash("")), "alias_denied");
  });
  test("non-UTF8 document refuses", async () => {
    writeFileSync(join(root, path), Buffer.from([0xff, 0xfe]));
    await denied(write(), "unsupported_kind");
  });
  test("oversized existing document refuses", async () => {
    const large = "x".repeat(BRAIN_APPLICATION_MAX_BYTES + 1);
    writeFileSync(join(root, path), large);
    await denied(write(path, "Replacement", contentHash(large)), "payload_too_large");
  });
  test("stale base refuses", async () => {
    await denied(write(path, "Replacement", contentHash("old base")), "stale_base");
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
  });
  test("concurrent content survives without overwrite or merge", async () => {
    beforeCommit = () => writeFileSync(join(root, path), "Penelope added a sail.\n");
    await denied(write(), "stale_base");
    expect(readFileSync(join(root, path), "utf8")).toBe("Penelope added a sail.\n");
  });
  test("revoked principal refuses at commit time", async () => {
    beforeCommit = () => { authorized = false; };
    await denied(write(), "authority_revoked");
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
  });
  test("operation missing from membership refuses", async () => {
    available = ["add"];
    await denied(write(), "membership_denied");
    expect(approvals).toEqual([]);
  });
  test("forged tool and command grant nothing", async () => {
    await denied({ ...write(), toolName: "brain_add", command: "allow write" }, "invalid_request");
  });
  test("identity cannot be supplied by the worker", async () => {
    const result = await application()({ ...request(write()), principalId: "athena" });
    expect(result.code).toBe("authority_revoked");
    expect(result.changes).toEqual([]); policyUnchanged();
  });
  test("permitted write and edit apply with no extra approval and accurate history", async () => {
    const apply = application();
    const result = await apply(request(write()));
    expect(result.ok).toBe(true); expect(result.indexed).toBe(true);
    expect(result.changes).toEqual([{ path, contentHash: contentHash("Odysseus sails.\n") }]);
    const base = readBrainApplicationBase(root, path);
    const edit = await apply(request({ operation: "edit", path, expectedBaseHash: base.expectedBaseHash, old_string: "sails", new_string: "rows" }));
    expect(edit.ok).toBe(true); expect(readFileSync(join(root, path), "utf8")).toBe("Odysseus rows.\n");
    expect(approvals).toEqual([]); expect(receipts).toEqual([result, edit]); policyUnchanged();
  });
  test("kernel write failure cleans private staging and preserves Markdown", async () => {
    const bwrap = Bun.which("bwrap"); expect(bwrap).not.toBeNull();
    const child = Bun.spawn([bwrap!, "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "/bin/sh", "-c", "trap '' XFSZ; ulimit -f 64; exec \"$@\"", "fixture", process.execPath,
      "--preload", resolve("scripts/test-network-child-preload.ts"), resolve("packages/ui-server/tests/fixtures/brain-application-fault.ts"), root],
      { cwd: process.cwd(), env: keylessEnv(root), stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    const { result, receipts: recorded } = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(result.ok).toBe(false); expect(result.message).toMatch(/EFBIG|File too large/i);
    expect(result.changes).toEqual([]); expect(recorded).toEqual([result]);
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
    expect(readdirSync(join(root, "notes")).some(name => name.startsWith(".brain-apply"))).toBe(false);
  });
  test("applications preserve existing document modes including archive moves", async () => {
    chmodSync(join(root, path), 0o640);
    expect((await application()(request(write()))).ok).toBe(true);
    expect(statSync(join(root, path)).mode & 0o7777).toBe(0o640);
    const source = "projects/active/harbor.md";
    const content = "---\ntitle: Harbor\ntype: project\nstatus: active\n---\nOdysseus prepares the harbor.\n";
    writeFileSync(join(root, source), content); chmodSync(join(root, source), 0o640);
    const archived = await application()(request({ operation: "archive", path: source, expectedBaseHash: contentHash(content) }));
    expect(archived.ok).toBe(true);
    expect(statSync(join(root, "projects/archive/harbor.md")).mode & 0o7777).toBe(0o640);
  });
  test("archive keeps its explicit confirmation", async () => {
    approved = false;
    await denied({ operation: "archive", path, expectedBaseHash: contentHash(raw) }, "permission_denied");
    expect(approvals).toHaveLength(1);
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
  });
  test("archiving update keeps its explicit confirmation", async () => {
    approved = false;
    await denied({ operation: "update", path, expectedBaseHash: contentHash(raw), status: "archived" }, "permission_denied");
  });
  test("staged application changes only exact named files", async () => {
    const result = await application()(request({ operation: "staged", files: [
      { path, expectedBaseHash: contentHash(raw), content: "Odysseus stages a raft.\n" },
      { path: "notes/staged.md", expectedBaseHash: null, content: "Athena checks the sail.\n" },
    ] }));
    expect(result.ok).toBe(true); expect(result.changes.map(c => c.path)).toEqual([path, "notes/staged.md"]);
    expect(readFileSync(join(root, path), "utf8")).toBe("Odysseus stages a raft.\n");
    expect(readFileSync(join(root, "notes/staged.md"), "utf8")).toBe("Athena checks the sail.\n"); policyUnchanged();
  });
  test("staged conflict applies none of its proposed files or directories", async () => {
    await denied({ operation: "staged", files: [
      { path: "new-notes/staged.md", expectedBaseHash: null, content: "Odysseus stages a raft.\n" },
      { path, expectedBaseHash: contentHash("stale"), content: "Wrong base" },
    ] }, "stale_base");
    expect(existsSync(join(root, "new-notes"))).toBe(false);
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
  });
  test("cancellation before commit leaves no change or temporary file", async () => {
    beforeCommit = () => signal.abort();
    await denied(write(), "cancelled");
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
    expect(readdirSync(join(root, "notes")).some(name => name.startsWith(".brain-apply"))).toBe(false);
  });
  test("cancellation after commit records the complete Markdown effect", async () => {
    beforeCommit = () => queueMicrotask(() => signal.abort());
    const result = await application()(request(write()));
    expect(signal.signal.aborted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.changes).toEqual([{ path, contentHash: contentHash("Odysseus sails.\n") }]);
    expect(readFileSync(join(root, path), "utf8")).toBe("Odysseus sails.\n");
    expect(receipts).toEqual([result]);
  });
  test("membership revoked while applying refuses", async () => {
    beforeCommit = () => available.splice(available.indexOf("write"), 1);
    await denied(write(), "membership_denied");
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
  });
  test("duplicate staged files refuse before any effect", async () => {
    await denied({ operation: "staged", files: [
      { path, expectedBaseHash: contentHash(raw), content: "Odysseus sails." },
      { path, expectedBaseHash: contentHash(raw), content: "Athena waits." },
    ] }, "invalid_request");
  });
  test("ambiguous edit refuses before any effect", async () => {
    await denied({ operation: "edit", path, expectedBaseHash: contentHash(raw), old_string: "absent", new_string: "replacement" }, "edit_conflict");
  });
  test("invalid frontmatter date refuses", async () => {
    await denied({ operation: "update", path, expectedBaseHash: contentHash(raw), deadline: "tomorrow" }, "invalid_request");
  });
  test("queued cancellation never reaches Markdown", async () => {
    const release = await lock.acquire("brain-docs");
    try {
      const pending = application()(request(write())); signal.abort();
      const result = await pending;
      expect(result.ok).toBe(false); expect(result.changes).toEqual([]);
      expect(readFileSync(join(root, path), "utf8")).toBe(raw);
    } finally { release(); }
  });
});
