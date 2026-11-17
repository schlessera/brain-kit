/**
 * The media inventory (#2780): which files become media findings, with which
 * provenance and fingerprint, and what the pin snapshot can and cannot admit.
 * Real Git, real files, offline; the cast is Odysseus's and the day 2026-07-12.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalFindings } from "../src/lib/hygiene";
import { DEFAULT_MEDIA_POLICY, type MediaPolicy } from "../src/lib/media";
import {
  buildMediaInventory,
  countedMedia,
  mediaCandidates,
  mediaInventory,
  pinnedPathLimit,
  readScratchPins,
} from "../src/lib/media-inventory";
import { assess } from "../src/lib/sync/assess";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HARBOUR = ".brain/scratch/2026-07-12/ithaca-harbour.png";
const DRAFT = ".brain/scratch/2026-07-12/loom-draft-03.png";
const VOYAGE = ["pi", "voyage-home"];
const key = (backend: string, session: string) => JSON.stringify([backend, session]);

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function put(root: string, path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

/** A Git brain that ignores `.brain/`, as a generated one ignores its scratch area. */
function brain(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-media-inventory-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  put(root, ".gitignore", ".brain/\n");
  put(root, "places/ithaca.md", "# Ithaca\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "commit", "-qm", "fixture");
  return root;
}

function pins(root: string, sessions: Record<string, string[]>, ready = true): void {
  put(root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready, sessions }));
}

const policy = (over: Partial<MediaPolicy> = {}): MediaPolicy => ({ ...DEFAULT_MEDIA_POLICY, maxTrackedBytes: 1024, ...over });
const inventoryOf = (root: string, p = policy(), limit?: number) => mediaInventory(root, p, assess(root, p), readScratchPins(root, limit));
const findingsOf = (root: string, p = policy(), limit?: number) => canonicalFindings(mediaCandidates(inventoryOf(root, p, limit)));

describe("admission", () => {
  test("assessment media and conversation-pinned scratch only: no scratch walk, no ignored non-scratch file", () => {
    const root = brain();
    put(root, "photos/penelope-loom.png", "png bytes");
    put(root, "assets/renders/loom.png", "rendered");
    put(root, HARBOUR, "harbour bytes");
    put(root, DRAFT, "draft bytes");
    pins(root, { [key(...VOYAGE as [string, string])]: [HARBOUR] });
    // The pinned scratch file matches media.ignore too, and is still admitted.
    const inv = inventoryOf(root, policy({ ignore: ["assets/renders/**", ".brain/scratch/**"] }));
    expect(inv.items.map((i) => [i.path, i.source])).toEqual([
      [HARBOUR, "scratch"],
      ["photos/penelope-loom.png", "content"],
    ]);
    expect(inv.items[0]!.policy).toEqual(["ignore .brain/scratch/**"]);
    expect(inv.links).toEqual({ state: "complete", observed: 1, limit: 5000, tooLarge: false, symlinks: 0 });
  });

  test("MEDIA and LARGE on one file are one finding with both provenances; LARGE is a warning, MEDIA informational", () => {
    const root = brain();
    put(root, "voyage/storm-at-sea.mp4", "x".repeat(2048));
    put(root, "photos/ithaca-shore.jpg", "small");
    const findings = [...findingsOf(root).values()];
    expect(findings.map((f) => [f.path, f.severity, f.sources.map((s) => s.name)])).toEqual([
      ["photos/ithaca-shore.jpg", "info", ["media"]],
      ["voyage/storm-at-sea.mp4", "warning", ["large", "media"]],
    ]);
    expect(findings.map((f) => [f.category, f.urgency])).toEqual([["media", null], ["media", null]]);
    expect(Object.keys(findings[0]!.fingerprintFields)).toEqual(["sha256", "bytes", "classes", "policy", "refs", "pins", "severity", "urgency"]);
  });

  test("a pinned symlink is counted with no finding; a pinned missing path is nothing; scratch findings never count", () => {
    const root = brain();
    put(root, HARBOUR, "harbour bytes");
    mkdirSync(join(root, ".brain/scratch/2026-07-12"), { recursive: true });
    symlinkSync("ithaca-harbour.png", join(root, ".brain/scratch/2026-07-12/harbour-link.png"));
    pins(root, { [key("pi", "voyage-home")]: [HARBOUR, ".brain/scratch/2026-07-12/harbour-link.png", ".brain/scratch/2026-07-12/gone.png"] });
    const inv = inventoryOf(root);
    expect(inv.items.map((i) => i.path)).toEqual([HARBOUR]);
    expect(inv.links.symlinks).toBe(1);
    expect([...canonicalFindings(mediaCandidates(inv)).values()].filter(countedMedia).map((f) => f.path)).toEqual([]);
  });
});

describe("pin snapshot", () => {
  test("ready:false admits its listed paths as incomplete evidence", () => {
    const root = brain();
    put(root, HARBOUR, "harbour bytes");
    pins(root, { [key("pi", "voyage-home")]: [HARBOUR] }, false);
    const inv = inventoryOf(root);
    expect(inv.links.state).toBe("incomplete");
    expect(inv.items.map((i) => i.path)).toEqual([HARBOUR]);
  });

  test("missing, malformed or redirected snapshots admit nothing and report unknown", () => {
    const root = brain();
    put(root, HARBOUR, "harbour bytes");
    expect(inventoryOf(root).links.state).toBe("unknown");
    for (const bad of ["{not json", JSON.stringify({ version: 2, ready: true, sessions: {} }),
      JSON.stringify({ version: 1, ready: true, sessions: { [key("pi", "voyage-home")]: ["../../etc/passwd"] } })]) {
      put(root, ".brain/scratch-pins/pins.json", bad);
      const inv = inventoryOf(root);
      expect(inv.links.state).toBe("unknown");
      expect(inv.items).toEqual([]);
    }
    rmSync(join(root, ".brain/scratch-pins"), { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "brain-pins-elsewhere-"));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "pins.json"), JSON.stringify({ version: 1, ready: true, sessions: { [key("pi", "voyage-home")]: [HARBOUR] } }));
    symlinkSync(elsewhere, join(root, ".brain/scratch-pins"));
    expect(inventoryOf(root).links.state).toBe("unknown");
  });

  test("5,001 pinned paths hit the default bound: 5,000 read, discovery reported incomplete", () => {
    const root = brain();
    const listed = Array.from({ length: 5001 }, (_, i) => `.brain/scratch/2026-07-12/frame-${String(i).padStart(5, "0")}.png`);
    put(root, listed[0]!, "first frame");
    put(root, listed[5000]!, "last frame");
    pins(root, { [key("pi", "voyage-home")]: listed });
    const inv = inventoryOf(root);
    expect(inv.links).toEqual({ state: "complete", observed: 5001, limit: 5000, tooLarge: true, symlinks: 0 });
    // The path past the bound is not read, so it is not claimed either way.
    expect(inv.items.map((i) => i.path)).toEqual([listed[0]]);
  });

  test("a trusted host override sets the bound; anything but a positive integer is refused", () => {
    const root = brain();
    for (const name of ["a", "b", "c"]) put(root, `.brain/scratch/2026-07-12/${name}.png`, name);
    pins(root, { [key("pi", "voyage-home")]: ["a", "b", "c"].map((n) => `.brain/scratch/2026-07-12/${n}.png`) });
    const previous = process.env.BRAIN_MEDIA_PINNED_PATH_LIMIT;
    try {
      process.env.BRAIN_MEDIA_PINNED_PATH_LIMIT = "2";
      const inv = buildMediaInventory(root, policy());
      expect(inv.links).toMatchObject({ observed: 3, limit: 2, tooLarge: true });
      expect(inv.items).toHaveLength(2);
      process.env.BRAIN_MEDIA_PINNED_PATH_LIMIT = "0";
      expect(() => buildMediaInventory(root, policy())).toThrow("positive integer");
    } finally {
      if (previous === undefined) delete process.env.BRAIN_MEDIA_PINNED_PATH_LIMIT;
      else process.env.BRAIN_MEDIA_PINNED_PATH_LIMIT = previous;
    }
    expect(pinnedPathLimit(undefined)).toBe(5000);
    expect(() => pinnedPathLimit("12abc")).toThrow();
  });
});

describe("fingerprint", () => {
  test("pins change it only for sessions linking that path; bytes always change it", () => {
    const root = brain();
    put(root, HARBOUR, "harbour bytes");
    put(root, DRAFT, "draft bytes");
    pins(root, { [key("pi", "voyage-home")]: [HARBOUR] });
    const before = [...findingsOf(root).values()][0]!;
    // An unrelated conversation linking a different file.
    pins(root, { [key("pi", "voyage-home")]: [HARBOUR], [key("claude", "loom-plans")]: [DRAFT] });
    const unrelated = [...findingsOf(root).values()].find((f) => f.path === HARBOUR)!;
    expect(unrelated.fingerprint).toBe(before.fingerprint);
    // A second conversation linking the same file.
    pins(root, { [key("pi", "voyage-home")]: [HARBOUR], [key("claude", "loom-plans")]: [HARBOUR] });
    const linked = [...findingsOf(root).values()][0]!;
    expect(linked.fingerprint).not.toBe(before.fingerprint);
    expect(Object.entries(linked.fingerprintFields).filter(([k, v]) => before.fingerprintFields[k] !== v).map(([k]) => k)).toEqual(["pins"]);
    put(root, HARBOUR, "harbour bytes, recropped");
    const edited = [...findingsOf(root).values()][0]!;
    expect(Object.entries(edited.fingerprintFields).filter(([k, v]) => linked.fingerprintFields[k] !== v).map(([k]) => k)).toEqual(["sha256", "bytes"]);
  });
});
