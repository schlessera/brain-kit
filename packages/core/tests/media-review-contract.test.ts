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
    writeFileSync(config, readFileSync(config, "utf8").replace("export default defineConfig({", 'export default defineConfig({\n  media: { track: ["places/ithaca/penelope-loom.png"], ignore: [".brain/scratch/**"] },'));
    write(root, ".gitignore", `${readFileSync(join(root, ".gitignore"), "utf8")}.brain/\n`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "media policy");
    git(root, "push", "-q", "origin", "main");
    write(root, "photos/penelope-loom.png", "loom bytes");
    write(root, "places/ithaca/penelope-loom.png", "loom bytes");
    write(root, "photos/achilles-shield.jpg", "shield bytes");
    write(root, "photos/trojan-horse.jpg", "horse bytes");
    write(root, "photos/argus-waiting.jpg", "argus bytes");
    write(root, "photos/scylla-strait.jpg", "scylla bytes");
    write(root, "photos/cyclops-cave.jpg", "cyclops bytes");
    write(root, ".brain/scratch/2026-07-12/ithaca-harbour.png", "harbour bytes");
    write(root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { [JSON.stringify(["pi", "voyage-home"])]: [".brain/scratch/2026-07-12/ithaca-harbour.png"] } }));

    const first = await json(root, "hygiene", "next");
    expect(first.body.media).toMatchObject({ awaitingReview: 6, setAside: 0, kept: 0, links: { state: "complete", observed: 1 } });
    const media = ((await json(root, "hygiene", "list", "--state", "open")).body.entries as Array<{ id: string; path: string; fingerprint: string; sources: Array<{ name: string }> }>)
      .filter((e) => e.id.startsWith("media-"));
    const at = (path: string) => media.find((e) => e.path === path)!;
    // Pinned scratch is a review-only finding: listed, never counted.
    expect(at(".brain/scratch/2026-07-12/ithaca-harbour.png").sources.map((s) => s.name)).toEqual(["scratch-media"]);
    expect((await json(root, "hygiene", "dismiss", at("photos/achilles-shield.jpg").id, "--expect-fingerprint", at("photos/achilles-shield.jpg").fingerprint)).code).toBe(0);
    // One snooze in force, and one that has come due (its until edited into the past by hand).
    for (const path of ["photos/scylla-strait.jpg", "photos/cyclops-cave.jpg"])
      expect((await json(root, "hygiene", "snooze", at(path).id, "--until", "2099-01-01", "--expect-fingerprint", at(path).fingerprint)).code).toBe(0);
    const snoozed = join(root, LOG, "snoozed.md");
    const cyclops = at("photos/cyclops-cave.jpg").id;
    writeFileSync(snoozed, readFileSync(snoozed, "utf8").replace(new RegExp(`(### ${cyclops}[\\s\\S]*?- until: )2099-01-01`), "$12026-01-01"));

    // A kept original, recorded the way Keep a permanent copy will (#2781): only for a valid copy with the verified bytes.
    const loom = at("photos/penelope-loom.png"), argus = at("photos/argus-waiting.jpg");
    const copySha = new Bun.CryptoHasher("sha256").update("loom bytes").digest("hex");
    const keep = (sha: string) => json(root, "hygiene", "keep-copy", loom.id, "--expect-fingerprint", loom.fingerprint,
      "--copy", "places/ithaca/penelope-loom.png", "--copy-sha256", sha, "--journal", "7c1e");
    const changed = await keep("0".repeat(64));
    expect(changed.code).toBe(1);
    expect(changed.body).toMatchObject({ status: "refused", reason: "copy-changed", id: loom.id });
    expect(existsSync(join(root, LOG, "kept.md"))).toBe(false);
    const recorded = await keep(copySha);
    expect(recorded.code).toBe(0);
    expect(recorded.body).toMatchObject({ status: "kept", id: loom.id, fingerprint: loom.fingerprint, until: null, reason: null,
      changedFiles: expect.arrayContaining([`${LOG}/kept.md`]), copy: "places/ithaca/penelope-loom.png", copySha256: copySha, journal: "7c1e" });
    expect(Object.keys(recorded.body)).toEqual(["status", "id", "fingerprint", "until", "reason", "changedFiles", "copy", "copySha256", "journal"]);
    const keptText = readFileSync(join(root, LOG, "kept.md"), "utf8");
    expect(keptText).toContain(`### ${loom.id}\n`);
    expect(keptText).toContain(`- copy: \`places/ithaca/penelope-loom.png\`\n- copy-sha256: ${copySha}\n- journal: 7c1e\n- disposition-fingerprint: ${loom.fingerprint} (`);
    const keptEntry = ((await json(root, "hygiene", "list", "--state", "kept")).body.entries as Array<Record<string, unknown>>)[0]!;
    expect(keptEntry).toMatchObject({ id: loom.id, state: "kept", copy: "places/ithaca/penelope-loom.png", copySha256: copySha,
      disposition: { kind: "kept", fingerprint: loom.fingerprint } });
    const fingerprintLine = (id: string) => readFileSync(join(root, LOG, "open.md"), "utf8").split(`### ${id}`)[1]!.split("\n").find((l) => l.startsWith("- **Fingerprint**:"))!.replace("- **Fingerprint**: ", "");
    const kept = (id: string, path: string, copy: boolean) => [`### ${id}`, `- **Files**: \`${path}\``, `- **Fingerprint**: ${fingerprintLine(id)}`, "- kept-on: 2026-07-12",
      ...(copy ? ["- copy: `places/ithaca/penelope-loom.png`"] : []), `- copy-sha256: ${"3e91a0c4".repeat(8)}`, `- disposition-fingerprint: ${fingerprintLine(id)}`].join("\n");
    // And one whose record cannot be checked, moved in by hand.
    write(root, `${LOG}/kept.md`, `${readFileSync(join(root, LOG, "kept.md"), "utf8").trimEnd()}\n\n${kept(argus.id, argus.path, false)}\n`);

    // Sync reads first, without reconciling; review reconciles and reads.
    const synced = await syncJson(root);
    const reviewed = await json(root, "hygiene", "next");
    expect(synced.body.run.leftovers.mediaPending).toBe(reviewed.body.media.awaitingReview);
    // Counted: the horse (open), argus (invalid kept) and the cyclops (due snooze).
    expect(synced.body.run.leftovers.mediaSetAside).toEqual({ dismissed: 1, snoozed: 1, kept: 1 });
    expect(reviewed.body.media).toMatchObject({ awaitingReview: 3, setAside: 2, kept: 1 });
    expect(synced.body.run.report).toContain("Media awaiting review: 3 · 2 set aside · 1 kept as a copy · review in Actions");
    // No media path: the tracked copy is only ever named as a committed note.
    for (const path of ["photos/", ".brain/scratch", "media: "]) expect(synced.body.run.report).not.toContain(path);
    expect(synced.body.agent).toEqual({ invoked: false, reason: "not-needed" });
    // A normally ignored (Git and media.ignore), conversation-linked scratch
    // file reaches review with what Keep a permanent copy needs: a scratch
    // source and a known conversation link (rev 4 §4.2).
    const harbour = at(".brain/scratch/2026-07-12/ithaca-harbour.png");
    const selected = await json(root, "hygiene", "next", "--finding", harbour.id, "--dry-run");
    expect(selected.body.finding).toMatchObject({ id: harbour.id, category: "media", severity: "info",
      media: { source: "scratch", classes: ["MEDIA"], links: { state: "complete", conversations: 1 } } });
    // The invalid kept record reopened with its receipt.
    expect(readFileSync(join(root, LOG, "open.md"), "utf8")).toContain("kept on 2026-07-12 · changed: kept-incomplete");
  }, 60_000);
});

describe("offline sync and review agree whatever the pin snapshot says", () => {
  test("complete, incomplete, unknown and overflowing snapshots never change the count, on either side", async () => {
    const brain = brainWithRemote();
    const { root } = brain;
    write(root, ".gitignore", `${readFileSync(join(root, ".gitignore"), "utf8")}.brain/\n`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "ignore the brain's operational state");
    git(root, "push", "-q", "origin", "main");
    write(root, "photos/penelope-loom.png", "loom bytes");
    const scratch = [".brain/scratch/2026-07-12/ithaca-harbour.png", ".brain/scratch/2026-07-12/sirens-rocks.png"];
    for (const path of scratch) write(root, path, path);
    const pins = (ready: boolean) => write(root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready, sessions: { [JSON.stringify(["pi", "voyage-home"])]: scratch } }));
    const cases: Array<[string, () => void, Record<string, string>, string, boolean]> = [
      ["complete", () => pins(true), {}, "complete", false],
      ["incomplete", () => pins(false), {}, "incomplete", false],
      ["unknown", () => write(root, ".brain/scratch-pins/pins.json", "{ not json"), {}, "unknown", false],
      ["overflowing", () => pins(true), { BRAIN_MEDIA_PINNED_PATH_LIMIT: "1" }, "complete", true],
    ];
    for (const [name, arrange, env, state, tooLarge] of cases) {
      arrange();
      const next = await runCli(root, ["hygiene", "next", "--json"], env);
      const sync = await runCli(root, ["sync", "--json"], env);
      const media = JSON.parse(next.stdout).media, leftovers = JSON.parse(sync.stdout).run.leftovers;
      expect([name, media.links.state, media.links.tooLarge]).toEqual([name, state, tooLarge]);
      expect([name, leftovers.mediaPending, leftovers.mediaSetAside]).toEqual([name, media.awaitingReview, { dismissed: 0, snoozed: 0, kept: 0 }]);
      expect([name, media.awaitingReview]).toEqual([name, 1]);
    }
  }, 120_000);
});
