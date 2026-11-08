/**
 * The descriptor-anchored governance policy read (#2508). `checkGovernancePolicy`
 * and ui-server's policy writer both read the protected file through it; the
 * writer's own characterization lives in
 * `packages/ui-server/tests/policy-proposal-read.test.ts`.
 *
 * Races are staged through `node:fs` spies on the descriptor's `fstatSync`, so
 * the same hooks drive every implementation without knowing how it reads.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spyOn } from "bun:test";
import { checkGovernancePolicy, GOVERNANCE_POLICY_MAX_BYTES, GOVERNANCE_POLICY_PATH } from "../src/governance-policy";

const policy = "---\nschema_version: 1\nprofiles:\n  interactive: governed\n---\nPenelope keeps the policy.\n";
const replacement = "---\nschema_version: 1\nprofiles:\n  interactive: strict\n---\nThe suitors rewrote the policy.\n";
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function brain(content: string | null = policy) {
  const root = mkdtempSync(join(tmpdir(), "governance-read-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "context/policies"), { recursive: true });
  const path = join(root, GOVERNANCE_POLICY_PATH);
  if (content !== null) writeFileSync(path, content);
  return { root, path };
}

/**
 * Runs `hook` once, when the reader first fstats a regular file (the policy
 * descriptor before its bytes are read), and lets `size` override what every
 * regular-file fstat reports. Restored in teardown.
 */
function onPolicyStat(hook?: () => void, size?: (real: number) => number) {
  const original = fs.fstatSync;
  let fired = false;
  const spy = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: fs.StatOptions) => {
    const info = original(fd, options as never) as fs.Stats;
    if (!info.isFile()) return info;
    if (!fired && hook) { fired = true; hook(); }
    if (size) Object.defineProperty(info, "size", { value: size(info.size) });
    return info;
  }) as typeof fs.fstatSync);
  cleanup.push(() => spy.mockRestore());
  return () => fired;
}

/** Largest single result either read API handed back for a descriptor. */
function readHighWater() {
  const readSync = fs.readSync, readFileSync = fs.readFileSync;
  let most = 0;
  const a = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const n = (readSync as (...x: unknown[]) => number)(...args); most = Math.max(most, n); return n;
  }) as typeof fs.readSync);
  const b = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const out = (readFileSync as (...x: unknown[]) => Buffer | string)(...args);
    if (typeof args[0] === "number") most = Math.max(most, out.length);
    return out;
  }) as typeof fs.readFileSync);
  cleanup.push(() => { a.mockRestore(); b.mockRestore(); });
  return () => most;
}

function withPlatform(platform: NodeJS.Platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  cleanup.push(() => Object.defineProperty(process, "platform", descriptor));
}

/** Moves `context` aside and puts a fresh tree holding `replacement` at the old name. */
function replaceAncestry(root: string) {
  renameSync(join(root, "context"), join(root, "old-context"));
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, GOVERNANCE_POLICY_PATH), replacement);
}

test("a valid policy is read with the hash of its exact bytes", () => {
  const { root } = brain();
  const checked = checkGovernancePolicy(root);
  expect(checked.status).toBe("valid");
  expect(checked.content_hash).toBe(sha(policy));
});

test("a missing file and a missing ancestor both select defaults as missing", () => {
  expect(checkGovernancePolicy(brain(null).root)).toMatchObject({ ok: true, status: "missing", content_hash: null, errors: [] });
  const { root } = brain(null);
  rmSync(join(root, "context"), { recursive: true });
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: true, status: "missing", content_hash: null });
});

test("a symlinked policy file is refused, not followed", () => {
  const { root, path } = brain(null);
  writeFileSync(join(root, "elsewhere.md"), policy);
  symlinkSync(join(root, "elsewhere.md"), path);
  const checked = checkGovernancePolicy(root);
  expect(checked).toMatchObject({ ok: false, status: "invalid", content_hash: null });
  expect(checked.errors[0]).toMatch(/ELOOP|symbolic link/i);
});

test("a symlinked ancestor is refused, not followed", () => {
  const { root } = brain();
  renameSync(join(root, "context"), join(root, "real-context"));
  symlinkSync(join(root, "real-context"), join(root, "context"));
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: false, status: "invalid", content_hash: null });
});

test("a hardlinked policy file is refused", () => {
  const { root, path } = brain();
  linkSync(path, join(root, "alias.md"));
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: false, status: "invalid", errors: ["Policy must be a regular file without hardlink aliases"] });
});

test("a FIFO at the policy name is refused without blocking", () => {
  const { path, root } = brain(null);
  const made = Bun.spawnSync(["mkfifo", path]);
  expect(made.exitCode).toBe(0);
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: false, status: "invalid", errors: ["Policy must be a regular file without hardlink aliases"] });
});

test("an oversized policy is refused before its bytes are read", () => {
  const { root } = brain("x".repeat(GOVERNANCE_POLICY_MAX_BYTES + 1));
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: false, status: "invalid", errors: ["Policy exceeds the 1 MiB input bound"] });
});

test("a short read (fewer bytes than the descriptor reported) is refused as a change", () => {
  const { root } = brain();
  onPolicyStat(undefined, real => real + 16);
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: false, status: "invalid", errors: ["Policy changed while it was read; retry the check or repair the edit"] });
});

test("a file that grows during the read is refused as a change", () => {
  const { root, path } = brain();
  onPolicyStat(() => fs.appendFileSync(path, "Antinous appended this.\n"));
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: false, status: "invalid", errors: ["Policy changed while it was read; retry the check or repair the edit"] });
});

test("a file that grows past the bound after its size check never loads more than the bound", () => {
  const { root, path } = brain();
  const highWater = readHighWater();
  onPolicyStat(() => fs.appendFileSync(path, "x".repeat(4 * GOVERNANCE_POLICY_MAX_BYTES)), () => policy.length);
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: false, status: "invalid" });
  expect(highWater()).toBeLessThanOrEqual(GOVERNANCE_POLICY_MAX_BYTES + 1);
});

test("an ancestor replaced while the policy is read is refused on Linux (the writer's rule)", () => {
  if (process.platform !== "linux") return;
  const { root } = brain();
  const fired = onPolicyStat(() => replaceAncestry(root));
  const checked = checkGovernancePolicy(root);
  expect(fired()).toBe(true);
  expect(checked, "GOVERNANCE_READ_LINUX_ANCESTRY_RECHECK").toMatchObject({ ok: false, status: "invalid", errors: ["Policy ancestry changed while it was read"] });
});

test("an ancestor removed while the policy is read is refused, not reported missing (non-Linux traversal)", () => {
  const { root } = brain();
  withPlatform("darwin");
  const fired = onPolicyStat(() => renameSync(join(root, "context"), join(root, "old-context")));
  const checked = checkGovernancePolicy(root);
  expect(fired()).toBe(true);
  expect(checked, "GOVERNANCE_READ_REMOVED_ANCESTOR_IS_NOT_MISSING").toMatchObject({ ok: false, status: "invalid", errors: ["Policy ancestry changed while it was read"] });
});

test("an ancestor replaced while the policy is read is refused (non-Linux traversal)", () => {
  const { root } = brain();
  withPlatform("darwin");
  onPolicyStat(() => replaceAncestry(root));
  expect(checkGovernancePolicy(root)).toMatchObject({ ok: false, status: "invalid", errors: ["Policy ancestry changed while it was read"] });
});
