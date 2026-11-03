/**
 * The four media review effects (#2781, rev 4 §5-§7): Delete, Move, Persist
 * here and Keep a permanent copy. Each is planned read-only, then applied
 * only against the premise it previewed, and the actual file, reference and
 * config bytes are inspected after. Compensation and Undo belong to the
 * journal holder (ui-server), so here an apply never restores anything.
 * Real Git and files, offline; Odysseus's cast, the day 2026-07-12.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalFindings, type HygieneFinding } from "../src/lib/hygiene";
import { DEFAULT_MEDIA_POLICY, type MediaPolicy } from "../src/lib/media";
import { planMediaPolicyEdit, readMediaPolicyLists } from "../src/lib/media-config-edit";
import { applyMediaEffect, planMediaEffect, type MediaEffectContext, type MediaEffectPlan, type MediaEffectRequest } from "../src/lib/media-effects";
import { buildMediaInventory, mediaCandidates } from "../src/lib/media-inventory";
import { DEFAULT_MEDIA_REFERENCE_LIMITS } from "../src/lib/media-references";

const LOOM = "photos/penelope-loom.png";
const SCRATCH = ".brain/scratch/2026-07-12/harbour-dawn.jpg";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}
function put(root: string, path: string, bytes: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

function brain(config = "{}\n"): string {
  const root = mkdtempSync(join(tmpdir(), "brain-media-effects-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  put(root, ".gitignore", ".brain/\n");
  put(root, "brain.config.json", config);
  put(root, "places/ithaca.md", "# Ithaca\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "commit", "-qm", "fixture");
  put(root, LOOM, "loom bytes");
  return root;
}
function pin(root: string, path: string, ready = true) {
  put(root, path, "dawn bytes");
  put(root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready, sessions: { '["claude","ithaca"]': [path], '["claude","troy"]': [path] } }));
}

function policyOf(root: string): MediaPolicy {
  const lists = readMediaPolicyLists(read(root, "brain.config.json"), "json");
  return { ...DEFAULT_MEDIA_POLICY, ...lists };
}
const ctx = (root: string, over: Partial<MediaEffectContext> = {}): MediaEffectContext => ({ root, policy: policyOf(root), configPath: "brain.config.json", ...over });
function finding(root: string, path: string): HygieneFinding {
  return [...canonicalFindings(mediaCandidates(buildMediaInventory(root, policyOf(root)))).values()].find((f) => f.path === path)!;
}
function plan(root: string, action: MediaEffectRequest["action"], path: string, destination?: string, over: Partial<MediaEffectContext> = {}) {
  const f = finding(root, path);
  const request: MediaEffectRequest = { id: f.id, action, expectFingerprint: f.fingerprint, ...(destination ? { destination } : {}) };
  return { request, preview: planMediaEffect(ctx(root, over), request) as MediaEffectPlan };
}
function apply(root: string, request: MediaEffectRequest, preview: MediaEffectPlan, over: Partial<MediaEffectContext> = {}) {
  return applyMediaEffect(ctx(root, over), { ...request, expectPremise: preview.premiseDigest, journal: "odysseus-0001" });
}

describe("Delete", () => {
  test("previews the file and its references, then removes exactly that file", () => {
    const root = brain();
    put(root, "journeys/return.md", "# Return\n\n![loom](../photos/penelope-loom.png)\n<img src=\"../photos/penelope-loom.png\">\n");
    const { request, preview } = plan(root, "delete", LOOM);
    expect(preview.refusals).toEqual([]);
    expect(preview.files, "DELETE_PLAN_FILES").toEqual([{ path: LOOM, role: "source", before: sha("loom bytes"), after: null, bytes: 10 }]);
    expect(preview.captureBytes).toBe(10);
    expect(preview.references).toEqual({ complete: true, count: 2 });
    expect(preview.blockers.map((b) => b.kind), "DELETE_LISTS_DETECTED_ONLY").toEqual(["html"]);
    expect(existsSync(join(root, LOOM)), "PREVIEW_WRITES_NOTHING").toBe(true);
    const result = apply(root, request, preview);
    expect(result).toMatchObject({ status: "applied", files: [{ path: LOOM, state: "removed" }] });
    expect(existsSync(join(root, LOOM)), "DELETE_REMOVED").toBe(false);
    expect(read(root, "journeys/return.md"), "DELETE_LEAVES_NOTES").toContain("penelope-loom.png");
  });

  test("a file edited after the preview is stale, and nothing is removed", () => {
    const root = brain();
    const { request, preview } = plan(root, "delete", LOOM);
    put(root, LOOM, "Athena's later loom");
    expect(apply(root, request, preview), "DELETE_STALE_FINGERPRINT").toMatchObject({ status: "stale", files: [] });
    expect(read(root, LOOM)).toBe("Athena's later loom");
  });

  test("a premise that differs from the previewed one is stale even with the same fingerprint", () => {
    const root = brain();
    const { request, preview } = plan(root, "delete", LOOM);
    const result = applyMediaEffect(ctx(root), { ...request, expectPremise: "0".repeat(64), journal: "odysseus-0001" });
    expect(result, "DELETE_PREMISE_BINDING").toMatchObject({ status: "stale", reason: "premise-changed" });
    expect(read(root, LOOM)).toBe("loom bytes");
    expect(preview.premiseDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Move", () => {
  const NOTE = [
    "# Return",
    "",
    "![loom](../photos/penelope-loom.png)",
    "![root](/photos/penelope-loom.png?w=320#top)",
    "[angle](<../photos/penelope-loom.png>)",
    "![[penelope-loom.png|240]]",
    "[[photos/penelope-loom.png]]",
    "`../photos/penelope-loom.png` stays code",
    "",
    "[loom]: ../photos/penelope-loom.png",
    "",
  ].join("\n");

  test("rewrites every declared reference in its own style and leaves code alone", () => {
    const root = brain();
    put(root, "journeys/return.md", NOTE);
    const { request, preview } = plan(root, "move", LOOM, "places/ithaca/loom.png");
    expect(preview.refusals).toEqual([]);
    expect(preview.files.map((f) => [f.role, f.path]), "MOVE_PLAN_ORDER").toEqual([
      ["directory", "places/ithaca"], ["destination", "places/ithaca/loom.png"], ["source", LOOM], ["note", "journeys/return.md"]]);
    const result = apply(root, request, preview);
    expect(result.status, result.reason).toBe("applied");
    expect(read(root, "places/ithaca/loom.png"), "MOVE_BYTES").toBe("loom bytes");
    expect(existsSync(join(root, LOOM))).toBe(false);
    expect(read(root, "journeys/return.md"), "MOVE_GOLDEN_REWRITE").toBe([
      "# Return",
      "",
      "![loom](../places/ithaca/loom.png)",
      "![root](/places/ithaca/loom.png?w=320#top)",
      "[angle](<../places/ithaca/loom.png>)",
      "![[places/ithaca/loom.png|240]]",
      "[[places/ithaca/loom.png]]",
      "`../photos/penelope-loom.png` stays code",
      "",
      "[loom]: ../places/ithaca/loom.png",
      "",
    ].join("\n"));
  });

  test("a bare wiki name that still matches by basename is left as written", () => {
    const root = brain();
    put(root, "journeys/return.md", "![[penelope-loom.png]]\n");
    const { request, preview } = plan(root, "move", LOOM, "places/penelope-loom.png");
    expect(preview.rewrites).toEqual([]);
    expect(apply(root, request, preview).status).toBe("applied");
    expect(read(root, "journeys/return.md"), "MOVE_MINIMAL_EDIT").toBe("![[penelope-loom.png]]\n");
  });

  test("detected-only references refuse the move before any write", () => {
    const root = brain();
    put(root, "journeys/return.md", "---\ntitle: Return\ncover: ../photos/penelope-loom.png\n---\n# Return\n");
    const { request, preview } = plan(root, "move", LOOM, "places/loom.png");
    expect(preview.refusals, "MOVE_REF_UNSUPPORTED").toEqual([{ code: "ref-unsupported", path: "journeys/return.md", line: 3 }]);
    expect(preview.files).toEqual([]);
    expect(apply(root, request, preview).status).toBe("refused");
    expect(read(root, LOOM)).toBe("loom bytes");
  });

  test("destination guards: final location, existing file, case/normalization sibling, secret name, containment", () => {
    const root = brain();
    put(root, "places/Loom.png", "another loom");
    const codes = (to: string) => plan(root, "move", LOOM, to).preview.refusals.map((r) => r.code);
    expect(codes(".brain/scratch/loom.png"), "MOVE_NOT_FINAL").toEqual(["not-final-location"]);
    expect(codes("workspaces/athena/loom.png")).toEqual(["not-final-location"]);
    expect(codes("places/Loom.png"), "MOVE_NO_OVERWRITE").toEqual(["exists"]);
    expect(codes("places/loom.png"), "MOVE_NAME_COLLISION").toEqual(["name-collision"]);
    expect(codes("places/ithaca.md/loom.png")).toEqual(["not-contained"]);
    expect(codes("../outside.png")).toEqual(["not-contained"]);
    expect(codes("places/loom.key"), "MOVE_SECRET_NAME").toEqual(["secret-name"]);
    expect(read(root, LOOM)).toBe("loom bytes");
  });

  test("the rewritten-notes bound admits its limit and refuses one past it", () => {
    const root = brain();
    for (const n of [1, 2, 3]) put(root, `journeys/day-${n}.md`, "![loom](../photos/penelope-loom.png)\n");
    const at = plan(root, "move", LOOM, "places/loom.png", { limits: { ...DEFAULT_MEDIA_REFERENCE_LIMITS, rewrittenNotes: 3 } }).preview;
    expect(at.refusals, "REWRITTEN_NOTES_BOUNDARY").toEqual([]);
    const over = plan(root, "move", LOOM, "places/loom.png", { limits: { ...DEFAULT_MEDIA_REFERENCE_LIMITS, rewrittenNotes: 2 } }).preview;
    expect(over.refusals, "REWRITTEN_NOTES_PLUS_ONE").toEqual([{ code: "inventory-too-large", limit: "rewrittenNotes", effective: 2, observed: 3 }]);
  });

  test("the preview bound admits its own size and refuses one byte less", () => {
    const root = brain();
    const size = Buffer.byteLength(JSON.stringify(plan(root, "delete", LOOM).preview));
    expect(plan(root, "delete", LOOM, undefined, { limits: { ...DEFAULT_MEDIA_REFERENCE_LIMITS, preview: size } }).preview.status, "PREVIEW_BOUNDARY").toBe("preview");
    const over = planMediaEffect(ctx(root, { limits: { ...DEFAULT_MEDIA_REFERENCE_LIMITS, preview: size - 1 } }), plan(root, "delete", LOOM).request);
    expect(over, "PREVIEW_PLUS_ONE").toMatchObject({ status: "refused", refusals: [{ code: "inventory-too-large", limit: "preview", effective: size - 1, observed: size }] });
  });

  test("a note edited after the preview makes the apply stale with nothing moved", () => {
    const root = brain();
    put(root, "journeys/return.md", "![loom](../photos/penelope-loom.png)\n");
    const { request, preview } = plan(root, "move", LOOM, "places/loom.png");
    put(root, "journeys/return.md", "![loom](../photos/penelope-loom.png)\nAthena's later line\n");
    expect(apply(root, request, preview), "MOVE_NOTE_PREMISE").toMatchObject({ status: "stale", reason: "premise-changed", files: [] });
    expect(read(root, LOOM)).toBe("loom bytes");
    expect(existsSync(join(root, "places/loom.png"))).toBe(false);
  });

  test("linked scratch refuses Move, and unknown links refuse it too", () => {
    const root = brain();
    pin(root, SCRATCH);
    expect(plan(root, "move", SCRATCH, "places/dawn.jpg").preview.refusals.map((r) => r.code), "MOVE_LINKED_SCRATCH").toEqual(["pinned-scratch"]);
    const other = brain();
    pin(other, SCRATCH, false);
    expect(plan(other, "move", SCRATCH, "places/dawn.jpg").preview.refusals.map((r) => r.code)).toEqual(["pinned-scratch"]);
  });
});

describe("Persist here", () => {
  test("adds the exact media.track entry by a minimal splice and the file classes TRACK", () => {
    const root = brain('{\n  "title": "Ithaca"\n}\n');
    const { request, preview } = plan(root, "persist", LOOM);
    expect(preview.configDiff, "PERSIST_DIFF").toEqual({ path: "brain.config.json", track: { before: [], after: [LOOM] }, ignore: { before: [], after: [] } });
    expect(preview.resultClass).toBe("TRACK");
    expect(apply(root, request, preview).status).toBe("applied");
    expect(read(root, "brain.config.json"), "PERSIST_CONFIG_BYTES").toBe('{\n  "title": "Ithaca", "media": { "track": ["photos/penelope-loom.png"] }\n}\n');
    expect(read(root, LOOM)).toBe("loom bytes");
    expect(finding(root, LOOM), "PERSIST_NO_LONGER_PENDING").toBeUndefined();
  });

  test("an exact ignore of this path is removed in the same edit; a broader ignore is not adjusted here", () => {
    const root = brain(`{ "media": { "ignore": ["${LOOM}", "*.psd"] } }\n`);
    put(root, LOOM, "loom bytes");
    // Ignored media is not pending; plan against an explicit finding by making it visible first.
    expect(planMediaPolicyEdit(read(root, "brain.config.json"), "json", { addTrack: LOOM, removeIgnore: LOOM }).text, "PERSIST_REMOVES_EXACT_IGNORE")
      .toBe(`{ "media": { "ignore": ["*.psd"], "track": ["${LOOM}"] } }\n`);
  });

  test("root-level files have no exact form; non-literal configs are refused", () => {
    const root = brain();
    put(root, "map.png", "map bytes");
    expect(plan(root, "persist", "map.png").preview.refusals, "PERSIST_ROOT_NOT_EXPRESSIBLE").toEqual([{ code: "not-expressible", path: "map.png" }]);
    const ts = brain();
    rmSync(join(ts, "brain.config.json"));
    put(ts, "brain.config.ts", "const media = { track: [] };\nexport default { media };\n");
    const f = [...canonicalFindings(mediaCandidates(buildMediaInventory(ts, DEFAULT_MEDIA_POLICY))).values()].find((v) => v.path === LOOM)!;
    const refused = planMediaEffect({ root: ts, policy: DEFAULT_MEDIA_POLICY, configPath: "brain.config.ts" }, { id: f.id, action: "persist", expectFingerprint: f.fingerprint }) as MediaEffectPlan;
    expect(refused.refusals, "PERSIST_CONFIG_NOT_LITERAL").toEqual([{ code: "config-not-literal", path: "brain.config.ts" }]);
    expect(read(ts, "brain.config.ts")).toBe("const media = { track: [] };\nexport default { media };\n");
  });

  test("a defineConfig TypeScript literal keeps every other byte", () => {
    const source = 'import { defineConfig } from "@schlessera/brain";\n\nexport default defineConfig({\n  media: {\n    track: ["places/**"], // committed\n  },\n});\n';
    expect(planMediaPolicyEdit(source, "ts", { addTrack: LOOM }).text, "PERSIST_TS_SPLICE")
      .toBe('import { defineConfig } from "@schlessera/brain";\n\nexport default defineConfig({\n  media: {\n    track: ["places/**", "photos/penelope-loom.png"], // committed\n  },\n});\n');
  });

  test("scratch is never persisted in place", () => {
    const root = brain();
    pin(root, SCRATCH);
    expect(plan(root, "persist", SCRATCH).preview.refusals.map((r) => r.code), "PERSIST_SCRATCH").toEqual(["not-final-location"]);
  });
});

describe("Keep a permanent copy", () => {
  test("copies a linked scratch original, tracks the copy, and leaves the original and its pins untouched", () => {
    const root = brain();
    pin(root, SCRATCH);
    const pins = read(root, ".brain/scratch-pins/pins.json");
    const { request, preview } = plan(root, "keep-copy", SCRATCH, "places/ithaca/harbour-dawn.jpg");
    expect(preview.refusals).toEqual([]);
    expect(preview.links, "KEEP_LINKS").toEqual({ state: "linked", conversations: 2 });
    expect(preview.copy?.sha256).toBe(sha("dawn bytes"));
    // Only the config's pre-image is captured: the original is never modified.
    expect(preview.captureBytes, "KEEP_NEVER_CAPTURES_ORIGINAL").toBe(Buffer.byteLength("{}\n"));
    const result = apply(root, request, preview);
    expect(result).toMatchObject({ status: "applied", copySha256: sha("dawn bytes") });
    expect(read(root, "places/ithaca/harbour-dawn.jpg"), "KEEP_COPY_BYTES").toBe("dawn bytes");
    expect(read(root, SCRATCH), "KEEP_ORIGINAL_BYTES").toBe("dawn bytes");
    expect(read(root, ".brain/scratch-pins/pins.json"), "KEEP_PINS_BYTES").toBe(pins);
    expect(readMediaPolicyLists(read(root, "brain.config.json"), "json").track).toEqual(["places/ithaca/harbour-dawn.jpg"]);
    expect(readdirSync(join(root, "places/ithaca")), "KEEP_NO_PART_RESIDUE").toEqual(["harbour-dawn.jpg"]);
  });

  test("a copy destination that appears after the preview is never overwritten", () => {
    const root = brain();
    pin(root, SCRATCH);
    const { request, preview } = plan(root, "keep-copy", SCRATCH, "places/harbour-dawn.jpg");
    put(root, "places/harbour-dawn.jpg", "Telemachus's own photo");
    expect(apply(root, request, preview), "KEEP_NO_OVERWRITE").toMatchObject({ status: "refused", refusals: [{ code: "exists", path: "places/harbour-dawn.jpg" }], files: [] });
    expect(read(root, "places/harbour-dawn.jpg")).toBe("Telemachus's own photo");
  });

  test("content media is not offered a copy", () => {
    const root = brain();
    expect(plan(root, "keep-copy", LOOM, "places/loom.png").preview.refusals.map((r) => r.code), "KEEP_NOT_SCRATCH").toEqual(["not-linked-scratch"]);
  });
});
