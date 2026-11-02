/**
 * Media in the hygiene log (#2780): the `kept` disposition and its validity,
 * and the one count (`mediaReviewCounts`) sync and review share. Real Git and
 * real files, offline, Odysseus's brain on 2026-07-12.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalFindings, HygieneRefusal, mediaReviewCounts, readHygieneLog, reconcile, type HygieneFinding } from "../src/lib/hygiene";
import { DEFAULT_MEDIA_POLICY, type MediaPolicy } from "../src/lib/media";
import { mediaCandidates, mediaInventory, readScratchPins } from "../src/lib/media-inventory";
import { assess } from "../src/lib/sync/assess";

const NOW = new Date("2026-07-12T09:00:00Z");
const LOOM = "photos/penelope-loom.png";
const COPY = "places/ithaca/penelope-loom.png";
const SHIELD = "photos/achilles-shield.jpg";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}
function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function brain(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-hygiene-media-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  put(root, ".gitignore", ".brain/\n");
  put(root, "places/ithaca.md", "# Ithaca\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "commit", "-qm", "fixture");
  put(root, LOOM, "loom bytes");
  put(root, COPY, "loom bytes");
  return root;
}

const policyWithCopy: MediaPolicy = { ...DEFAULT_MEDIA_POLICY, track: [COPY] };
const candidatesOf = (root: string, policy = policyWithCopy) => mediaCandidates(mediaInventory(root, policy, assess(root, policy), readScratchPins(root)));
const findingsOf = (root: string, policy = policyWithCopy) => canonicalFindings(candidatesOf(root, policy));
const findingAt = (root: string, path: string, policy = policyWithCopy): HygieneFinding => [...findingsOf(root, policy).values()].find((f) => f.path === path)!;
const fp = (f: HygieneFinding) => `${f.fingerprint} (${Object.entries(f.fingerprintFields).map(([k, v]) => `${k} ${v}`).join(", ")})`;
const HEAD = (title: string, heading: string) =>
  `---\ntype: context\ntitle: "${title}"\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n## ${heading}\n\n`;

/** A kept entry for `finding`, as Keep a permanent copy (#2781) will write it. */
function keptEntry(finding: HygieneFinding, lines: { copy?: string | null; sha?: string } = {}): string {
  return [
    `### ${finding.id}`,
    `- **Files**: \`${finding.path}\``,
    "- **Issue**: Media awaits a decision before it is committed (10 B)",
    "- **First seen**: 2026-07-12 · **Last seen**: 2026-07-12",
    "- **Sources**: hygiene/media (info)",
    `- **Fingerprint**: ${fp(finding)}`,
    "- kept-on: 2026-07-12",
    ...(lines.copy === null ? [] : [`- copy: \`${lines.copy ?? COPY}\``]),
    `- copy-sha256: ${lines.sha ?? "3e91a0c4".repeat(8)}`,
    "- journal: 7c1e",
    `- disposition-fingerprint: ${fp(finding)}`,
  ].join("\n");
}
function writeKept(root: string, ...entries: string[]): void {
  put(root, "context/hygiene/kept.md", `${HEAD("Hygiene — Kept Media", "Kept as a permanent copy")}${entries.join("\n\n")}\n`);
}
const run = (root: string, policy = policyWithCopy) => reconcile(root, candidatesOf(root, policy), new Map(), { now: NOW, media: policy });
const counts = (root: string, now = NOW, policy = policyWithCopy) => mediaReviewCounts(root, policy, findingsOf(root, policy), readHygieneLog(root), now);

describe("kept", () => {
  test("a valid kept original stays kept, out of the count, and an edited copy keeps it so", () => {
    const root = brain();
    const loom = findingAt(root, LOOM);
    writeKept(root, keptEntry(loom));
    const first = run(root);
    expect(first.kept).toBe(1);
    expect(first.invalidations).toEqual([]);
    expect(counts(root)).toEqual({ awaitingReview: 0, setAside: 0, kept: 1, dismissed: 0, snoozed: 0 });
    const entry = readHygieneLog(root).find((e) => e.id === loom.id)!;
    expect(entry).toMatchObject({ state: "kept", copy: COPY, copySha256: "3e91a0c4".repeat(8), keptOn: "2026-07-12",
      disposition: { kind: "kept", on: "2026-07-12", reason: null, fingerprint: loom.fingerprint } });
    put(root, COPY, "loom bytes, cropped");
    expect(run(root).kept).toBe(1);
  });

  for (const [why, change, changed] of [
    ["the copy is gone", (root: string) => rmSync(join(root, COPY)), ["copy-missing"]],
    ["the copy sits inside .brain", (root: string) => writeKept(root, keptEntry(findingAt(root, LOOM), { copy: ".brain/scratch/loom.png" })), ["copy-missing"]],
    ["the record has no copy line", (root: string) => writeKept(root, keptEntry(findingAt(root, LOOM), { copy: null })), ["kept-incomplete"]],
    ["the original's bytes changed", (root: string) => put(root, LOOM, "loom bytes, rewoven"), ["sha256", "bytes"]],
  ] as const) {
    test(`it opens again, with a receipt, when ${why}`, () => {
      const root = brain();
      writeKept(root, keptEntry(findingAt(root, LOOM)));
      change(root);
      const result = run(root);
      expect(result.kept).toBe(0);
      expect(result.invalidations).toEqual([{ id: expect.any(String), disposition: "kept", dispositionOn: "2026-07-12", changed: [...changed], previousId: null }]);
      expect(readFileSync(join(root, "context/hygiene/open.md"), "utf8")).toContain(`- invalidated: 2026-07-12 · kept on 2026-07-12 · changed: ${changed.join(", ")}`);
      const open = readHygieneLog(root).find((e) => e.state === "open")!;
      expect(open.invalidation).toMatchObject({ disposition: "kept", changed: [...changed] });
      expect(counts(root).awaitingReview).toBe(1);
    });
  }

  test("a rule that stops tracking the copy reopens the original as copy-untracked", () => {
    const root = brain();
    writeKept(root, keptEntry(findingAt(root, LOOM)));
    const untracked = { ...DEFAULT_MEDIA_POLICY };
    // The original returns, and the copy itself is now media awaiting review too.
    expect(counts(root, NOW, untracked)).toMatchObject({ awaitingReview: 2, kept: 0 });
    expect(run(root, untracked).invalidations).toEqual([expect.objectContaining({ id: findingAt(root, LOOM).id, changed: ["copy-untracked"] })]);
  });

  test("a pruned original resolves its kept entry; nothing is pending", () => {
    const root = brain();
    writeKept(root, keptEntry(findingAt(root, LOOM)));
    rmSync(join(root, LOOM));
    const result = run(root);
    expect(result).toMatchObject({ kept: 0, resolved: 1 });
    expect(readFileSync(join(root, "context/hygiene/resolved.md"), "utf8")).toContain("- resolved-by: original-pruned");
    // kept.md existed, so it is rewritten empty rather than removed.
    expect(readFileSync(join(root, "context/hygiene/kept.md"), "utf8")).toContain("## Kept as a permanent copy\n\n(empty)\n");
  });

  test("kept.md is never created empty, and _index.md gains no Kept line without it", () => {
    const root = brain();
    run(root);
    expect(existsSync(join(root, "context/hygiene/kept.md"))).toBe(false);
    expect(readFileSync(join(root, "context/hygiene/_index.md"), "utf8")).not.toContain("Kept");
  });
});

describe("recording kept", () => {
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const keep = (root: string, over: Partial<{ id: string; fingerprint: string; copy: string; copySha256: string }> = {}, policy = policyWithCopy) => {
    const loom = findingAt(root, LOOM, policy);
    return reconcile(root, candidatesOf(root, policy), new Map(), { now: NOW, media: policy, dispositions: [{ kind: "kept", id: over.id ?? loom.id,
      expectFingerprint: over.fingerprint ?? loom.fingerprint, copy: over.copy ?? COPY, copySha256: over.copySha256 ?? sha("loom bytes"), journal: "7c1e" }] });
  };
  const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as HygieneRefusal).reason; } return null; };

  test("a verified, tracked copy is recorded once and holds", () => {
    const root = brain();
    const result = keep(root);
    expect(result).toMatchObject({ kept: 1, changedFiles: expect.arrayContaining(["context/hygiene/kept.md"]) });
    expect(counts(root)).toMatchObject({ awaitingReview: 0, kept: 1 });
    expect(run(root).changedFiles).toEqual([]);
  });

  test("an invalid copy is refused before anything is written", () => {
    const root = brain();
    put(root, "notes/voyage.md", "# Voyage\n");
    expect(refusal(() => keep(root, { copySha256: sha("other bytes") }))).toBe("copy-changed");
    expect(refusal(() => keep(root, { copy: "places/ithaca/missing.png" }))).toBe("copy-missing");
    expect(refusal(() => keep(root, { copy: ".brain/scratch/loom.png" }))).toBe("copy-missing");
    expect(refusal(() => keep(root, {}, { ...DEFAULT_MEDIA_POLICY }))).toBe("copy-untracked");
    expect(refusal(() => keep(root, { fingerprint: "000000000000" }))).toBe("stale-fingerprint");
    expect(existsSync(join(root, "context/hygiene"))).toBe(false);
  });
});

describe("mediaReviewCounts", () => {
  /** Dismissed, snoozed and kept log files holding entries for the loom and the shield. */
  function logged(root: string, files: { dismissed?: string[]; snoozed?: string[]; kept?: string[] }): void {
    if (files.dismissed) put(root, "context/hygiene/dismissed.md", `${HEAD("Hygiene — Dismissed Issues", "Dismissed")}${files.dismissed.join("\n\n")}\n`);
    if (files.snoozed) put(root, "context/hygiene/snoozed.md", `${HEAD("Hygiene — Snoozed Issues", "Snoozed")}${files.snoozed.join("\n\n")}\n`);
    if (files.kept) writeKept(root, ...files.kept);
  }
  const disposed = (f: HygieneFinding, lines: string[]) => [`### ${f.id}`, `- **Files**: \`${f.path}\``, `- **Fingerprint**: ${fp(f)}`, ...lines].join("\n");

  test("valid dismissals and snoozes are set aside; a changed file counts again before any reconcile", () => {
    const root = brain();
    put(root, SHIELD, "shield bytes");
    const loom = findingAt(root, LOOM), shield = findingAt(root, SHIELD);
    logged(root, {
      dismissed: [disposed(loom, ["- dismissed-on: 2026-07-12T08:00:00Z", `- disposition-fingerprint: ${fp(loom)}`])],
      snoozed: [disposed(shield, ["- until: 2026-07-20", "- snoozed-on: 2026-07-12T08:00:00Z", `- disposition-fingerprint: ${fp(shield)}`])],
    });
    expect(counts(root)).toEqual({ awaitingReview: 0, setAside: 2, kept: 0, dismissed: 1, snoozed: 1 });
    // The snooze is due at its day's start: set aside 1 ms before, counted at it.
    expect(counts(root, new Date(Date.parse("2026-07-20T00:00:00Z") - 1)).snoozed).toBe(1);
    expect(counts(root, new Date("2026-07-20T00:00:00Z"))).toMatchObject({ awaitingReview: 1, snoozed: 0 });
    // Not trusting the containing file: new bytes under an old dismissal count.
    put(root, LOOM, "loom bytes, rewoven");
    expect(counts(root)).toMatchObject({ awaitingReview: 1, dismissed: 0 });
  });

  test("a legacy hand-moved dismissal (no fingerprint) is matched by ID; an invalid kept entry counts", () => {
    const root = brain();
    put(root, SHIELD, "shield bytes");
    const loom = findingAt(root, LOOM), shield = findingAt(root, SHIELD);
    logged(root, { dismissed: [disposed(loom, ["- dismissed-on: 2026-07-12"])], kept: [keptEntry(shield, { copy: null })] });
    expect(counts(root)).toEqual({ awaitingReview: 1, setAside: 1, kept: 0, dismissed: 1, snoozed: 0 });
  });
});
