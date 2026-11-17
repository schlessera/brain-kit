/**
 * How the policy writer reads the protected policy file (#2508): the base
 * snapshot taken when a change is proposed, and the re-checks around the
 * publication. Both go through common's descriptor-anchored reader
 * (`packages/common/tests/governance-policy-read.test.ts`); these cases pin
 * the writer's refusal states and messages on top of it.
 *
 * Races are staged through `node:fs` spies on the descriptor's `fstatSync`,
 * so the same hooks drive the writer however it reads the bytes.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { GOVERNANCE_POLICY_MAX_BYTES } from "@schlessera/brain-common/internal/governance-policy";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createUiDb } from "../src/db/client.js";
import { createPolicyProposals, type PolicyProposalTurn } from "../src/brain/policy-proposal.js";

const original = "---\nschema_version: 1\nprofiles:\n  interactive: governed\n---\nOdysseus reviews the policy.\n";
const proposed = original.replace("interactive: governed", "interactive: strict");
const replacement = original.replace("reviews", "rewrites");
const input = { content: proposed, rationale: "Use strict for the next turn." };
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function fixture(content: string | null = original, patch: Partial<Parameters<typeof createPolicyProposals>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "policy-read-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "context/policies"), { recursive: true });
  const path = join(root, "context/policies/governance.md");
  if (content !== null) writeFileSync(path, content);
  const db = createUiDb(":memory:"); cleanup.push(() => db.close());
  const reviews: PolicyChangeReview[] = [];
  let allow = false;
  const service = createPolicyProposals({ root, db, lock: createKeyedLock(), observeUserPolicy: (_id, write) => write(), recordEvent: () => {}, ...patch });
  const turn: PolicyProposalTurn = { principalId: "odysseus", turnId: "policy-read-turn", sessionId: () => null, signal: new AbortController().signal,
    isAuthorized: () => true, isAvailable: () => true, approve: async review => { reviews.push(structuredClone(review)); return allow; }, emit() {} };
  return { root, path, service, turn, reviews, approve: () => { allow = true; } };
}

/** Runs `hook` once, on the first regular-file fstat; `size` overrides every regular-file size. */
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

function replaceAncestry(root: string) {
  renameSync(join(root, "context"), join(root, "old-context"));
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, "context/policies/governance.md"), replacement);
}

test("the base snapshot hashes the exact current bytes", async () => {
  const f = fixture();
  expect((await f.service.propose(f.turn, "base", input)).state).toBe("declined");
  expect(f.reviews[0]!.baseHash).toBe(sha(original));
});

test("a missing file and a missing ancestor both propose against no base", async () => {
  const a = fixture(null);
  await a.service.propose(a.turn, "no-file", input);
  expect(a.reviews[0]!.baseHash).toBeNull();
  const b = fixture(null);
  rmSync(join(b.root, "context"), { recursive: true });
  await b.service.propose(b.turn, "no-ancestor", input);
  expect(b.reviews[0]!.baseHash).toBeNull();
});

test("a symlinked policy file or ancestor is refused before review", async () => {
  const a = fixture(null);
  writeFileSync(join(a.root, "elsewhere.md"), original); symlinkSync(join(a.root, "elsewhere.md"), a.path);
  await expect(a.service.propose(a.turn, "symlink", input)).rejects.toThrow(/ELOOP|symbolic link/i);
  const b = fixture();
  renameSync(join(b.root, "context"), join(b.root, "real-context")); symlinkSync(join(b.root, "real-context"), join(b.root, "context"));
  await expect(b.service.propose(b.turn, "ancestor", input)).rejects.toThrow();
  expect(a.reviews.length + b.reviews.length).toBe(0);
});

test("a hardlinked policy file or a FIFO is refused as not an ordinary file", async () => {
  const a = fixture();
  linkSync(a.path, join(a.root, "alias.md"));
  await expect(a.service.propose(a.turn, "hardlink", input)).rejects.toThrow("Policy must be an ordinary file with one link. Nothing was written.");
  const b = fixture(null);
  expect(Bun.spawnSync(["mkfifo", b.path]).exitCode).toBe(0);
  await expect(b.service.propose(b.turn, "fifo", input)).rejects.toThrow("Policy must be an ordinary file with one link. Nothing was written.");
});

test("an oversized policy is refused before its bytes are read", async () => {
  const f = fixture("x".repeat(GOVERNANCE_POLICY_MAX_BYTES + 1));
  await expect(f.service.propose(f.turn, "oversize", input)).rejects.toThrow("Policy exceeds the 1 MiB bound. Nothing was written.");
});

test("a short read (fewer bytes than the descriptor reported) is refused as stale", async () => {
  const f = fixture();
  onPolicyStat(undefined, real => real + 16);
  await expect(f.service.propose(f.turn, "short", input), "POLICY_WRITER_SHORT_READ").rejects.toThrow("Policy changed during review. Nothing was written.");
  expect(f.reviews).toHaveLength(0);
});

test("a file that grows during the read is refused as stale", async () => {
  const f = fixture();
  onPolicyStat(() => fs.appendFileSync(f.path, "Antinous appended this.\n"));
  await expect(f.service.propose(f.turn, "grows", input)).rejects.toThrow("Policy changed during review. Nothing was written.");
});

test("a file that grows past the bound after its size check never loads more than the bound", async () => {
  const f = fixture();
  const highWater = readHighWater();
  onPolicyStat(() => fs.appendFileSync(f.path, "x".repeat(4 * GOVERNANCE_POLICY_MAX_BYTES)), () => original.length);
  await expect(f.service.propose(f.turn, "unbounded", input)).rejects.toThrow("Policy changed during review. Nothing was written.");
  expect(highWater(), "POLICY_WRITER_BOUNDED_READ").toBeLessThanOrEqual(GOVERNANCE_POLICY_MAX_BYTES + 1);
});

test("an ancestor replaced while the base is read is refused", async () => {
  const f = fixture();
  const fired = onPolicyStat(() => replaceAncestry(f.root));
  await expect(f.service.propose(f.turn, "ancestry", input)).rejects.toThrow("Policy ancestry changed. Nothing was written.");
  expect(fired()).toBe(true);
});

test("an ancestor replaced between the publication's open and its verify is refused", async () => {
  const f = fixture(original, { beforeCommit: () => replaceAncestry(f.root) });
  f.approve();
  const review = await f.service.propose(f.turn, "ancestry-publish", input);
  expect(review).toMatchObject({ state: "refused", message: "Policy ancestry changed. Nothing was written." });
  expect(readFileSync(join(f.root, "old-context/policies/governance.md"), "utf8")).toBe(original);
  expect(readFileSync(f.path, "utf8")).toBe(replacement);
});

test("a policy file replaced by rename between the publication's open and its verify is stale", async () => {
  const f = fixture(original, { beforeCommit: () => { writeFileSync(join(f.root, "next.md"), replacement); renameSync(join(f.root, "next.md"), f.path); } });
  f.approve();
  const review = await f.service.propose(f.turn, "replaced-publish", input);
  expect(review).toMatchObject({ state: "stale", message: "The policy changed since this was proposed. Nothing was written. A fresh proposal is required." });
  expect(readFileSync(f.path, "utf8")).toBe(replacement);
});

test("a policy file hardlinked between the publication's open and its verify is refused", async () => {
  const f = fixture(original, { beforeCommit: () => linkSync(f.path, join(f.root, "alias.md")) });
  f.approve();
  const review = await f.service.propose(f.turn, "hardlink-publish", input);
  expect(review).toMatchObject({ state: "refused", message: "Policy must be an ordinary file with one link. Nothing was written." });
  expect(readFileSync(f.path, "utf8")).toBe(original);
});

test("publication creates the missing ancestry and the file", async () => {
  const f = fixture(null);
  rmSync(join(f.root, "context"), { recursive: true });
  f.approve();
  expect((await f.service.propose(f.turn, "create", input)).state).toBe("updated");
  expect(readFileSync(f.path, "utf8")).toBe(proposed);
});
