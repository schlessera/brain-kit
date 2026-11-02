/**
 * The #2780 contract, end to end through the real CLI on a real Git brain
 * with a remote: rev 6.1's goldens (G1–G6) for brains without media or kept
 * entries, the count-only sync report (G5), and parity between offline
 * `brain sync` and review's `brain hygiene next` for the same tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mediaReportLine } from "../src/lib/media-review";
import { renderReport } from "../src/lib/sync/report";
import type { RunEnvelope } from "../src/lib/sync/run";
import { runCli } from "./cli-harness";
import { brainWithRemote, cleanupFixtures, git, syncJson, write } from "./sync-fixture";

afterEach(cleanupFixtures);

const LOG = "context/hygiene";
const logBytes = (root: string) => readdirSync(join(root, LOG)).sort().map((name) => [name, readFileSync(join(root, LOG, name), "utf8")]);
const json = async (root: string, ...args: string[]) => {
  const r = await runCli(root, [...args, "--json"]);
  return { code: r.code, text: r.stdout, body: JSON.parse(r.stdout) };
};
/** G6: no legacy output carries `"kept"` as a state, kind, disposition or status. */
const KEPT_VALUE = /"(?:state|kind|disposition|status)":\s*"kept"/;

const LIST_KEYS = ["id", "state", "path", "issue", "firstSeen", "lastSeen", "until", "dueAt", "resolvedBy", "resolvedOn",
  "sources", "severity", "fingerprint", "disposition", "invalidation"];
const RECONCILE_KEYS = ["opened", "reopened", "resolved", "stillOpen", "snoozed", "dismissed", "invalidated", "invalidations",
  "changedFiles", "detected", "autoFixed", "failedChecks"];

/** A brain whose hygiene log has open, dismissed and snoozed entries, committed and pushed. */
async function legacyBrain() {
  const brain = brainWithRemote();
  const { root } = brain;
  expect((await json(root, "hygiene", "reconcile")).code).toBe(0);
  const open = (await json(root, "hygiene", "list", "--state", "open")).body.entries as Array<{ id: string; fingerprint: string }>;
  expect(open.length).toBeGreaterThanOrEqual(2);
  expect((await json(root, "hygiene", "dismiss", open[0]!.id, "--expect-fingerprint", open[0]!.fingerprint)).code).toBe(0);
  expect((await json(root, "hygiene", "snooze", open[1]!.id, "--until", "2099-01-01", "--expect-fingerprint", open[1]!.fingerprint)).code).toBe(0);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "hygiene log");
  git(root, "push", "-q", "origin", "main");
  return brain;
}

describe("rev 6.1 goldens on a brain with no media and no kept entries", () => {
  test("G1 file no-op, G2 legacy projection, G3 defaults present, G6 no kept value", async () => {
    const { root } = await legacyBrain();
    const before = logBytes(root);
    expect(before.map(([name]) => name)).not.toContain("kept.md");

    const reconciled = await json(root, "hygiene", "reconcile");
    const listed = await json(root, "hygiene", "list");
    const next = await json(root, "hygiene", "next");
    const refused = await json(root, "hygiene", "dismiss", "orphan-voyage-0000", "--expect-fingerprint", "000000000000");
    expect(refused.code).toBe(1);
    const synced = await syncJson(root);
    expect(synced.code).toBe(0);

    // G1: every hygiene file byte for byte, and no kept.md.
    expect(logBytes(root)).toEqual(before);
    expect(existsSync(join(root, LOG, "kept.md"))).toBe(false);
    expect(reconciled.body.changedFiles).toEqual([]);

    // G2 + G3: the new keys come last, with their fixed legacy values.
    expect(Object.keys(reconciled.body)).toEqual([...RECONCILE_KEYS, "kept"]);
    expect(reconciled.body.kept).toBe(0);
    const entries = listed.body.entries as Record<string, unknown>[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(Object.keys(entry)).toEqual([...LIST_KEYS, "copy", "copySha256", "keptOn"]);
      expect([entry.copy, entry.copySha256, entry.keptOn]).toEqual([null, null, null]);
    }
    expect(Object.keys(next.body)).toEqual(["finding", "counts", "media"]);
    expect(Object.keys(next.body.counts).at(-1)).toBe("kept");
    expect(next.body.counts.kept).toBe(0);
    expect(next.body.media).toMatchObject({ awaitingReview: 0, setAside: 0, kept: 0 });

    // G6
    for (const text of [reconciled.text, listed.text, next.text, refused.text, JSON.stringify(synced.body)]) expect(text).not.toMatch(KEPT_VALUE);

    // G5 (no media): no media line, and no path list either.
    expect(synced.body.run.report).not.toContain("Media");
    expect(synced.body.run.report).not.toContain("media:");
    expect(synced.body.run.leftovers).toMatchObject({ media: [], mediaPending: 0, mediaSetAside: { dismissed: 0, snoozed: 0, kept: 0 } });
  });
});

describe("G5: the routine report counts media and never names it", () => {
  const counts = (pending: number, dismissed: number, snoozed: number, kept: number) => ({ pending, setAside: { dismissed, snoozed, kept } });
  test("3/0/0, 3/2/1, 0/2/0 and no media", () => {
    expect(mediaReportLine(counts(3, 0, 0, 0))).toBe("Media awaiting review: 3 · review in Actions");
    expect(mediaReportLine(counts(3, 1, 1, 1))).toBe("Media awaiting review: 3 · 2 set aside · 1 kept as a copy · review in Actions");
    expect(mediaReportLine(counts(0, 2, 0, 0))).toBe("Media awaiting review: 0 · 2 set aside");
    expect(mediaReportLine(counts(0, 0, 0, 0))).toBeNull();
  });

  test("a report with media lists no path, and one without is unchanged", () => {
    const run = (media: RunEnvelope["leftovers"]["media"], mediaPending: number) => ({
      status: "complete", steps: { stash: [], assess: [], commit: [], pull: [], resolve: [], conclude: [], push: [], postSync: [] },
      leftovers: { unresolved: [], unknown: [], media, mediaPending, mediaSetAside: { dismissed: 0, snoozed: 0, kept: 0 } },
    }) as unknown as RunEnvelope;
    expect(renderReport(run([], 0))).toBe("brain sync: complete");
    expect(renderReport(run([{ path: "photos/penelope-loom.png", bytes: 2048 }], 1))).toBe("brain sync: complete\nMedia awaiting review: 1 · review in Actions");
  });
});

describe("offline sync and review agree", () => {
  test("same inventory, count and exclusions for open, dismissed, kept, invalid-kept and pinned scratch media", async () => {
    const brain = brainWithRemote();
    const { root } = brain;
    const config = join(root, "brain.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("export default defineConfig({", 'export default defineConfig({\n  media: { track: ["places/ithaca/penelope-loom.png"] },'));
    write(root, ".gitignore", `${readFileSync(join(root, ".gitignore"), "utf8")}.brain/\n`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "media policy");
    git(root, "push", "-q", "origin", "main");
    write(root, "photos/penelope-loom.png", "loom bytes");
    write(root, "places/ithaca/penelope-loom.png", "loom bytes");
    write(root, "photos/achilles-shield.jpg", "shield bytes");
    write(root, "photos/trojan-horse.jpg", "horse bytes");
    write(root, "photos/argus-waiting.jpg", "argus bytes");
    write(root, ".brain/scratch/2026-07-12/ithaca-harbour.png", "harbour bytes");
    write(root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { [JSON.stringify(["pi", "voyage-home"])]: [".brain/scratch/2026-07-12/ithaca-harbour.png"] } }));

    const first = await json(root, "hygiene", "next");
    expect(first.body.media).toMatchObject({ awaitingReview: 4, setAside: 0, kept: 0, links: { state: "complete", observed: 1 } });
    const media = ((await json(root, "hygiene", "list", "--state", "open")).body.entries as Array<{ id: string; path: string; fingerprint: string; sources: Array<{ name: string }> }>)
      .filter((e) => e.id.startsWith("media-"));
    const at = (path: string) => media.find((e) => e.path === path)!;
    // Pinned scratch is a review-only finding: listed, never counted.
    expect(at(".brain/scratch/2026-07-12/ithaca-harbour.png").sources.map((s) => s.name)).toEqual(["scratch-media"]);
    expect((await json(root, "hygiene", "dismiss", at("photos/achilles-shield.jpg").id, "--expect-fingerprint", at("photos/achilles-shield.jpg").fingerprint)).code).toBe(0);

    // A kept original, and one whose record cannot be checked.
    const loom = at("photos/penelope-loom.png"), argus = at("photos/argus-waiting.jpg");
    const fingerprintLine = (id: string) => readFileSync(join(root, LOG, "open.md"), "utf8").split(`### ${id}`)[1]!.split("\n").find((l) => l.startsWith("- **Fingerprint**:"))!.replace("- **Fingerprint**: ", "");
    const kept = (id: string, path: string, copy: boolean) => [`### ${id}`, `- **Files**: \`${path}\``, `- **Fingerprint**: ${fingerprintLine(id)}`, "- kept-on: 2026-07-12",
      ...(copy ? ["- copy: `places/ithaca/penelope-loom.png`"] : []), `- copy-sha256: ${"3e91a0c4".repeat(8)}`, `- disposition-fingerprint: ${fingerprintLine(id)}`].join("\n");
    write(root, `${LOG}/kept.md`, `---\ntype: context\ntitle: "Hygiene — Kept Media"\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n\n## Kept as a permanent copy\n\n${kept(loom.id, loom.path, true)}\n\n${kept(argus.id, argus.path, false)}\n`);

    // Sync reads first, without reconciling; review reconciles and reads.
    const synced = await syncJson(root);
    const reviewed = await json(root, "hygiene", "next");
    expect(synced.body.run.leftovers.mediaPending).toBe(reviewed.body.media.awaitingReview);
    expect(synced.body.run.leftovers.mediaSetAside).toEqual({ dismissed: 1, snoozed: 0, kept: 1 });
    expect(reviewed.body.media).toMatchObject({ awaitingReview: 2, setAside: 1, kept: 1 });
    expect(synced.body.run.report).toContain("Media awaiting review: 2 · 1 set aside · 1 kept as a copy · review in Actions");
    // No media path: the tracked copy is only ever named as a committed note.
    for (const path of ["photos/", ".brain/scratch", "media: "]) expect(synced.body.run.report).not.toContain(path);
    expect(synced.body.agent).toEqual({ invoked: false, reason: "not-needed" });
    // The invalid kept record reopened with its receipt.
    expect(readFileSync(join(root, LOG, "open.md"), "utf8")).toContain("kept on 2026-07-12 · changed: kept-incomplete");
  }, 60_000);
});
