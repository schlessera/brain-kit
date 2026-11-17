/**
 * The declared reference inventory behind media findings (#2781, rev 4 §3):
 * which note forms count, what code hides, every Q1 bound at its boundary and
 * one past it, and the `refs` digest each media fingerprint records.
 * Real files, offline; the cast is Odysseus's and the day 2026-07-12.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalFindings } from "../src/lib/hygiene";
import { DEFAULT_MEDIA_POLICY } from "../src/lib/media";
import { mediaCandidates, mediaInventory, readScratchPins } from "../src/lib/media-inventory";
import {
  DEFAULT_MEDIA_REFERENCE_LIMITS,
  mediaReferenceLimits,
  noteReferences,
  referenceDigest,
  resolveDestination,
  scanMediaReferences,
  type MediaReferenceLimits,
} from "../src/lib/media-references";
import { assess } from "../src/lib/sync/assess";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HARBOUR = "places/ithaca/harbour-dawn.jpg";

function put(root: string, path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

function brain(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-media-references-"));
  dirs.push(root);
  put(root, HARBOUR, "jpeg bytes");
  return root;
}

const limits = (over: Partial<MediaReferenceLimits> = {}): MediaReferenceLimits => ({ ...DEFAULT_MEDIA_REFERENCE_LIMITS, ...over });

describe("declared forms", () => {
  test("inline links and images, angle destinations, definitions, wiki links and embeds are rewritable", () => {
    const text = [
      "# Return to Ithaca",
      "",
      "![Dawn over the harbour](ithaca/harbour-dawn.jpg)",
      "See [the photo](<ithaca/harbour-dawn.jpg> \"dawn\").",
      "From the root: ![root](/places/ithaca/harbour-dawn.jpg)",
      "![Encoded](ithaca/harbour%2Ddawn.jpg)",
      "![[harbour-dawn.jpg|320]]",
      "[[places/ithaca/harbour-dawn.jpg#top]]",
      "",
      "[dawn]: ithaca/harbour-dawn.jpg",
      "",
    ].join("\n");
    const refs = noteReferences("places/ithaca.md", text, new Set([HARBOUR]));
    expect(refs.map((r) => [r.kind, r.line, r.target, r.rewritable])).toEqual([
      ["image", 3, "ithaca/harbour-dawn.jpg", true],
      ["link", 4, "ithaca/harbour-dawn.jpg", true],
      ["image", 5, "/places/ithaca/harbour-dawn.jpg", true],
      ["image", 6, "ithaca/harbour%2Ddawn.jpg", true],
      ["embed", 7, "harbour-dawn.jpg", true],
      ["wiki", 8, "places/ithaca/harbour-dawn.jpg", true],
      ["definition", 10, "ithaca/harbour-dawn.jpg", true],
    ]);
    // Each span is exactly the destination as written, so a rewrite touches nothing else.
    for (const r of refs) expect(text.slice(r.span![0], r.span![1])).toBe(r.target);
    expect(refs.filter((r) => r.path !== HARBOUR || r.note !== "places/ithaca.md").map((r) => [r.line, r.path, r.note])).toEqual([]);
  });

  test("frontmatter values and HTML src, href and poster are detected and never rewritable", () => {
    const text = [
      "---",
      "title: Return to Ithaca",
      "cover: ithaca/harbour-dawn.jpg",
      "gallery:",
      "  - harbour-dawn.jpg",
      "---",
      "",
      "<img src=\"ithaca/harbour-dawn.jpg\" alt=\"dawn\">",
      "<video poster='/places/ithaca/harbour-dawn.jpg'></video>",
      "",
    ].join("\n");
    const refs = noteReferences("places/ithaca.md", text, new Set([HARBOUR]));
    expect(refs.map((r) => [r.kind, r.target, r.rewritable, r.span])).toEqual([
      ["frontmatter", "ithaca/harbour-dawn.jpg", false, null],
      ["frontmatter", "harbour-dawn.jpg", false, null],
      ["html", "ithaca/harbour-dawn.jpg", false, null],
      ["html", "/places/ithaca/harbour-dawn.jpg", false, null],
    ]);
  });

  test("code blocks, inline code, URLs and unrelated text are never references", () => {
    const text = [
      "Penelope wrote `![x](ithaca/harbour-dawn.jpg)` on the loom.",
      "",
      "```md",
      "![x](ithaca/harbour-dawn.jpg)",
      "[[harbour-dawn.jpg]]",
      "```",
      "",
      "    ![indented](ithaca/harbour-dawn.jpg)",
      "",
      "![remote](https://example.test/places/ithaca/harbour-dawn.jpg)",
      "The file harbour-dawn.jpg is mentioned in prose only.",
      "![other](ithaca/harbour-dusk.jpg)",
      "",
    ].join("\n");
    expect(noteReferences("places/ithaca.md", text, new Set([HARBOUR]))).toEqual([]);
  });

  test("destinations resolve against the note, the root, and never outside the brain", () => {
    expect(resolveDestination("places/ithaca.md", "ithaca/harbour-dawn.jpg")).toBe(HARBOUR);
    expect(resolveDestination("people/odysseus.md", "../places/ithaca/harbour-dawn.jpg#x")).toBe(HARBOUR);
    expect(resolveDestination("people/odysseus.md", "/places/ithaca/harbour-dawn.jpg?v=2")).toBe(HARBOUR);
    expect(resolveDestination("odysseus.md", "../outside.jpg")).toBeNull();
    expect(resolveDestination("odysseus.md", "mailto:penelope@example.test")).toBeNull();
    expect(resolveDestination("odysseus.md", "#heading")).toBeNull();
  });
});

describe("scan", () => {
  test("reads notes only: hidden directories, the hygiene log and symlinked notes are skipped", () => {
    const root = brain();
    put(root, "places/ithaca.md", "![dawn](ithaca/harbour-dawn.jpg)\n");
    put(root, ".brain/scratch/notes.md", "![dawn](/places/ithaca/harbour-dawn.jpg)\n");
    put(root, "context/hygiene/open.md", "- **Files**: `places/ithaca/harbour-dawn.jpg`\n![x](/places/ithaca/harbour-dawn.jpg)\n");
    symlinkSync(join(root, "places/ithaca.md"), join(root, "linked.md"));
    const scan = scanMediaReferences(root, [HARBOUR]);
    expect(scan.status).toBe("complete");
    if (scan.status !== "complete") return;
    expect(scan.notes).toBe(1);
    expect(scan.references.get(HARBOUR)!.map((r) => r.note)).toEqual(["places/ithaca.md"]);
  });

  test("a note that is not UTF-8 refuses the scan as unscannable, naming the note", () => {
    const root = brain();
    put(root, "places/ithaca.md", "![dawn](ithaca/harbour-dawn.jpg)\n");
    put(root, "people/argos.md", new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    expect(scanMediaReferences(root, [HARBOUR])).toMatchObject({ status: "refused", refusal: { code: "inventory-unscannable", path: "people/argos.md", reason: "not-utf8" } });
  });

  test("an aborted scan is refused, never reported as complete", () => {
    const root = brain();
    put(root, "places/ithaca.md", "# Ithaca\n");
    const controller = new AbortController();
    controller.abort();
    expect(scanMediaReferences(root, [HARBOUR], { signal: controller.signal })).toMatchObject({ status: "refused", refusal: { code: "inventory-unscannable", reason: "aborted" } });
  });
});

describe("Q1 bounds: admitted at the boundary, refused one past it", () => {
  /** Three notes, two of them referencing the photo. */
  function three(): string {
    const root = brain();
    put(root, "a.md", ARGOS);
    put(root, "places/ithaca.md", "![](ithaca/harbour-dawn.jpg)\n");
    put(root, "places/sparta.md", "![](ithaca/harbour-dawn.jpg)\n");
    return root;
  }
  const ARGOS = "# Argos\n";
  const NOTE = "![](ithaca/harbour-dawn.jpg)\n".length;
  const TOTAL = ARGOS.length + NOTE * 2;
  /** An admitted scan is the whole inventory: every note opened, every reference found. */
  const COMPLETE = { status: "complete", notes: 3, bytes: TOTAL };
  const inventory = (scan: ReturnType<typeof scanMediaReferences>) =>
    scan.status === "complete" ? scan.references.get(HARBOUR)!.map((r) => [r.note, r.kind, r.line]).sort() : scan;
  const BOTH = [["places/ithaca.md", "image", 1], ["places/sparta.md", "image", 1]];

  test("notes", () => {
    const root = three();
    const at = scanMediaReferences(root, [HARBOUR], { limits: limits({ notes: 3 }) });
    expect(at, "NOTES_BOUNDARY").toMatchObject(COMPLETE);
    expect(inventory(at), "NOTES_BOUNDARY_INVENTORY").toEqual(BOTH);
    expect(scanMediaReferences(root, [HARBOUR], { limits: limits({ notes: 2 }) })).toMatchObject({ status: "refused", refusal: { code: "inventory-too-large", limit: "notes", effective: 2, observed: 3 } });
  });

  test("noteBytes", () => {
    const root = three();
    const at = scanMediaReferences(root, [HARBOUR], { limits: limits({ noteBytes: TOTAL, perNote: NOTE }) });
    expect(at, "NOTE_BYTES_BOUNDARY").toMatchObject(COMPLETE);
    expect(inventory(at), "NOTE_BYTES_BOUNDARY_INVENTORY").toEqual(BOTH);
    expect(scanMediaReferences(root, [HARBOUR], { limits: limits({ noteBytes: TOTAL - 1, perNote: NOTE }) })).toMatchObject({ status: "refused", refusal: { code: "inventory-too-large", limit: "noteBytes", effective: TOTAL - 1 } });
  });

  test("perNote", () => {
    const root = three();
    const at = scanMediaReferences(root, [HARBOUR], { limits: limits({ perNote: NOTE }) });
    expect(at, "PER_NOTE_BOUNDARY").toMatchObject(COMPLETE);
    expect(inventory(at), "PER_NOTE_BOUNDARY_INVENTORY").toEqual(BOTH);
    expect(scanMediaReferences(root, [HARBOUR], { limits: limits({ perNote: NOTE - 1 }) })).toMatchObject({ status: "refused", refusal: { code: "inventory-too-large", limit: "perNote", effective: NOTE - 1, observed: NOTE } });
  });

  test("scanTime, on the injected monotonic clock: admitted at exactly the limit, refused one millisecond past it", () => {
    const root = three();
    // The scan starts at 0, and every later reading is `elapsed`: each check sees exactly that much time gone.
    const frozen = (elapsed: number) => { let first = true; return () => (first ? ((first = false), 0) : elapsed); };
    const at = scanMediaReferences(root, [HARBOUR], { limits: limits({ scanTime: 20 }), now: frozen(20) });
    expect(at, "SCAN_TIME_BOUNDARY").toMatchObject(COMPLETE);
    expect(inventory(at), "SCAN_TIME_BOUNDARY_INVENTORY").toEqual(BOTH);
    expect(scanMediaReferences(root, [HARBOUR], { limits: limits({ scanTime: 20 }), now: frozen(21) }), "SCAN_TIME_PLUS_ONE")
      .toMatchObject({ status: "refused", refusal: { code: "inventory-too-large", limit: "scanTime", effective: 20, observed: 21 } });
    // A clock that keeps running past the limit mid-scan is refused too, never reported partly scanned.
    const ticking = () => { let t = 0; return () => (t += 10); };
    expect(scanMediaReferences(root, [HARBOUR], { limits: limits({ scanTime: 20 }), now: ticking() })).toMatchObject({ status: "refused", refusal: { limit: "scanTime", effective: 20 } });
  });

  test("refsPerFinding", () => {
    const root = three();
    const at = scanMediaReferences(root, [HARBOUR], { limits: limits({ refsPerFinding: 2 }) });
    expect(at, "REFS_BOUNDARY").toMatchObject(COMPLETE);
    expect(inventory(at), "REFS_BOUNDARY_INVENTORY").toEqual(BOTH);
    expect(scanMediaReferences(root, [HARBOUR], { limits: limits({ refsPerFinding: 1 }) })).toMatchObject({ status: "refused", refusal: { code: "inventory-too-large", limit: "refsPerFinding", effective: 1, observed: 2 } });
  });

  test("the defaults are the Q1 A values, written out rather than read back", () => {
    expect({ ...DEFAULT_MEDIA_REFERENCE_LIMITS }, "Q1_DEFAULTS").toEqual({
      notes: 50000,
      noteBytes: 268435456,
      perNote: 4194304,
      scanTime: 20000,
      refsPerFinding: 500,
      rewrittenNotes: 200,
      preview: 1048576,
    });
    expect(Object.isFrozen(DEFAULT_MEDIA_REFERENCE_LIMITS)).toBe(true);
    // An unset host value is the defaults, and so is a scan given no limits.
    expect(mediaReferenceLimits(undefined)).toEqual({ ...DEFAULT_MEDIA_REFERENCE_LIMITS });
    expect(scanMediaReferences(brain(), [HARBOUR]).limits, "Q1_DEFAULTS_SCAN").toBe(DEFAULT_MEDIA_REFERENCE_LIMITS);
  });

  test("trusted host limits are validated, partial, and refused rather than guessed", () => {
    expect(mediaReferenceLimits(undefined)).toEqual(DEFAULT_MEDIA_REFERENCE_LIMITS);
    expect(mediaReferenceLimits("notes=10, scanTime=5000")).toEqual({ ...DEFAULT_MEDIA_REFERENCE_LIMITS, notes: 10, scanTime: 5000 });
    for (const bad of ["notes=0", "notes=-1", "notes=1.5", "ships=3", "notes=1,notes=2", "perNote=9,noteBytes=8", "notes"]) {
      expect(() => mediaReferenceLimits(bad)).toThrow("BRAIN_MEDIA_REFERENCE_LIMITS");
    }
  });
});

describe("the refs fingerprint field", () => {
  test("none, a digest that ignores line moves, and a refusal reason instead of a digest", () => {
    const root = brain();
    put(root, "places/ithaca.md", "# Ithaca\n");
    const none = scanMediaReferences(root, [HARBOUR]);
    expect(referenceDigest(none, HARBOUR)).toBe("none");

    put(root, "places/ithaca.md", "# Ithaca\n\n![dawn](ithaca/harbour-dawn.jpg)\n");
    const one = referenceDigest(scanMediaReferences(root, [HARBOUR]), HARBOUR);
    expect(one).toMatch(/^[0-9a-f]{16}$/);

    put(root, "places/ithaca.md", "# Ithaca\n\nThe suitors waited.\n\n![dawn](ithaca/harbour-dawn.jpg)\n");
    expect(referenceDigest(scanMediaReferences(root, [HARBOUR]), HARBOUR)).toBe(one);

    put(root, "people/telemachus.md", "[[harbour-dawn.jpg]]\n");
    expect(referenceDigest(scanMediaReferences(root, [HARBOUR]), HARBOUR)).not.toBe(one);

    expect(referenceDigest(scanMediaReferences(root, [HARBOUR], { limits: limits({ notes: 1 }) }), HARBOUR)).toBe("too-large");
    put(root, "people/argos.md", new Uint8Array([0xff]));
    expect(referenceDigest(scanMediaReferences(root, [HARBOUR]), HARBOUR)).toBe("unscannable");
  });

  test("each media finding's fingerprint carries its own digest, and a new reference changes it", () => {
    const root = brain();
    Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"]);
    put(root, "places/ithaca.md", "# Ithaca\n");
    put(root, "places/sparta.png", "png bytes");
    const policy = { ...DEFAULT_MEDIA_POLICY, maxTrackedBytes: 1024 };
    const candidates = () => mediaCandidates(mediaInventory(root, policy, assess(root, policy), readScratchPins(root)));
    const findings = () => [...canonicalFindings(candidates()).values()];
    expect(candidates().map((c) => [c.path, c.facts?.refs])).toEqual([[HARBOUR, "none"], ["places/sparta.png", "none"]]);
    const before = findings();

    put(root, "places/ithaca.md", "# Ithaca\n\n![dawn](ithaca/harbour-dawn.jpg)\n");
    expect(candidates().find((c) => c.path === HARBOUR)!.facts?.refs).toMatch(/^[0-9a-f]{16}$/);
    const after = findings();
    const harbour = after.find((f) => f.path === HARBOUR)!, sparta = after.find((f) => f.path === "places/sparta.png")!;
    const old = before.find((f) => f.path === HARBOUR)!;
    expect(harbour.fingerprint).not.toBe(old.fingerprint);
    expect(Object.keys(harbour.fingerprintFields).filter((k) => harbour.fingerprintFields[k] !== old.fingerprintFields[k])).toEqual(["refs"]);
    expect(sparta.fingerprint).toBe(before.find((f) => f.path === "places/sparta.png")!.fingerprint);
  });
});
