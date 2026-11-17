/**
 * The server-owned markup application (#3975): what is written, where, and
 * every refusal that writes nothing.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAIN_MARKUP_MAX_BYTES, createKeyedLock, type BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";

import { markupProblem } from "../../module-images/src/markup.js";
import { createMarkupApplication, markupFilename, readMarkupBase } from "../src/brain/markup-application.js";
import { createFixtureMaintenanceHost } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { jpegWithOrientation, png } from "./helpers/markup-images.js";

const maintenanceOwners: ReturnType<typeof createFixtureMaintenanceHost>[] = [];
let root: string, controller: AbortController, authorized: boolean, available: boolean;
let records: BrainApplicationResult[], beforeCommit: (() => void) | undefined, afterLink: (() => void) | undefined;
const imagePath = "photos/raft-at-ithaca.png";
const W = 64, H = 48;
const source = png(W, H, { alpha: false, pixel: (x, y) => [x * 3, y * 4, 120, 255] });
/** Two red strokes on transparency: a real annotation layer. */
const layer = png(W, H, { pixel: (x, y) => (x === y || x === 40 ? [255, 59, 48, 255] : [0, 0, 0, 0]) });
const dir = ".brain/scratch/markup";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-markup-"));
  mkdirSync(join(root, "photos")); mkdirSync(join(root, "context/policies"), { recursive: true });
  mkdirSync(join(root, ".brain/scratch"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
  writeFileSync(join(root, imagePath), source);
  writeFileSync(join(root, "context/policies/crew.md"), "Athena owns these policy bytes.\n");
  controller = new AbortController(); authorized = true; available = true; records = []; beforeCommit = undefined; afterLink = undefined;
});
afterEach(() => { for (const host of maintenanceOwners.splice(0)) host.cleanup(); rmSync(root, { recursive: true, force: true }); });

function app(protectedPaths?: string[]) {
  const maintenance = createFixtureMaintenanceHost(root); maintenanceOwners.push(maintenance);
  return createMarkupApplication({ root, maintenance, principalId: "odysseus", turnId: "raft-turn", signal: controller.signal,
    lock: createKeyedLock(), isAuthorized: () => authorized, isAvailable: () => available, ...(protectedPaths ? { protectedPaths } : {}),
    record: result => records.push(result), beforeCommit: () => beforeCommit?.(), afterLink: () => afterLink?.() });
}
function request(overrides: Record<string, unknown> = {}) {
  return { principalId: "odysseus", turnId: "raft-turn", imagePath, png: layer, base: readMarkupBase(root, imagePath), ...overrides };
}
const layers = () => existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter(name => !name.startsWith(".")) : [];
async function refused(req: ReturnType<typeof request>, code: string, application = app()) {
  const before = layers();
  const result = await application(req);
  expect(result.ok, "the refusal is not an application").toBe(false);
  expect(result.code).toBe(code);
  expect(result.changes).toEqual([]);
  expect(layers(), "a refusal writes no layer").toEqual(before);
  if (existsSync(join(root, dir))) expect(readdirSync(join(root, dir)).filter(name => name.startsWith(".brain-markup-")), "no temporary is left").toEqual([]);
  expect(readFileSync(join(root, "context/policies/crew.md"), "utf8")).toBe("Athena owns these policy bytes.\n");
  expect(readFileSync(join(root, imagePath))).toEqual(source);
  expect(records).toEqual([result]);
  return result;
}

test("a layer is written byte for byte under .brain/scratch/markup with the source's name and hash", async () => {
  const base = readMarkupBase(root, imagePath);
  const hash = base.imageHash;
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect([base.width, base.height]).toEqual([W, H]);
  const result = await app()(request());
  expect(result.ok, result.message).toBe(true);
  const markupPath = `${dir}/raft-at-ithaca.${hash.slice(0, 8)}.markup.png`;
  expect(result.outcome).toEqual({ markupPath, bytes: layer.length, width: W, height: H });
  expect(readFileSync(join(root, markupPath))).toEqual(layer);
  expect(result.changes).toEqual([{ path: markupPath, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(records).toEqual([result]);
  // The source is never touched, and the layer is not a copy of it.
  expect(readFileSync(join(root, imagePath))).toEqual(source);
  expect(readdirSync(join(root, dir))).toEqual([markupPath.split("/").at(-1)!]);
});

test("brain image --markup accepts the written layer against its source", async () => {
  const result = await app()(request());
  const written = readFileSync(join(root, result.outcome!.markupPath));
  expect(markupProblem({ data: written, mime: "image/png", label: "layer" }, { data: readFileSync(join(root, imagePath)), mime: "image/png", label: "source" })).toBeNull();
  // And the CLI refuses what the application refuses: a flattened, opaque copy.
  expect(markupProblem({ data: source, mime: "image/png", label: "layer" }, { data: source, mime: "image/png", label: "source" })).toMatch(/no alpha channel/);
});

test("a repeated submission takes the next name and never rewrites an earlier receipt's layer", async () => {
  const first = await app()(request());
  const second = png(W, H, { pixel: (x) => (x === 10 ? [50, 210, 245, 255] : [0, 0, 0, 0]) });
  const again = await app()(request({ png: second }));
  expect(again.ok, again.message).toBe(true);
  expect(again.outcome!.markupPath).toBe(first.outcome!.markupPath.replace(".markup.png", "-2.markup.png"));
  expect(readFileSync(join(root, first.outcome!.markupPath))).toEqual(layer);
  expect(readFileSync(join(root, again.outcome!.markupPath))).toEqual(second);
});

test("a link planted at the layer's name is not followed; the next name is taken", async () => {
  const name = markupFilename(imagePath, readMarkupBase(root, imagePath).imageHash);
  mkdirSync(join(root, dir));
  symlinkSync(join(root, "context/policies/crew.md"), join(root, dir, name));
  const result = await app()(request());
  expect(result.ok, result.message).toBe(true);
  expect(result.outcome!.markupPath).toBe(`${dir}/${name.replace(".markup.png", "-2.markup.png")}`);
  expect(readFileSync(join(root, "context/policies/crew.md"), "utf8")).toBe("Athena owns these policy bytes.\n");
});

test("an EXIF orientation 6 JPEG binds its displayed, rotated size", async () => {
  const jpeg = "photos/raft-portrait.jpg";
  // Stored landscape 64 × 48; displayed portrait 48 × 64.
  writeFileSync(join(root, jpeg), jpegWithOrientation(64, 48, 6));
  const portrait = readMarkupBase(root, jpeg);
  expect([portrait.width, portrait.height]).toEqual([48, 64]);
  const rotated = png(48, 64, { pixel: (x) => (x === 5 ? [255, 214, 10, 255] : [0, 0, 0, 0]) });
  const ok = await app()(request({ imagePath: jpeg, base: readMarkupBase(root, jpeg), png: rotated }));
  expect(ok.ok, ok.message).toBe(true);
  expect(markupProblem({ data: rotated, mime: "image/png" }, { data: readFileSync(join(root, jpeg)), mime: "image/jpeg" })).toBeNull();
  records = [];
  // The stored, unrotated size is refused.
  const stored = await refused(request({ imagePath: jpeg, base: readMarkupBase(root, jpeg), png: png(64, 48) }), "invalid_dimensions");
  expect(stored.message).toContain("64x48 but the image is 48x64");
});

test("a layer that is not a transparent PNG of the source's size writes nothing", async () => {
  await refused(request({ png: Buffer.from("not a PNG at all") }), "invalid_png");
  records = [];
  await refused(request({ png: png(W, H, { alpha: false }) }), "invalid_png");
  records = [];
  await refused(request({ png: png(W + 1, H) }), "invalid_dimensions");
  records = [];
  await refused(request({ png: new Uint8Array() }), "empty_markup");
});

test("a layer that only claims a PNG header, or whose image data is cut short, writes nothing", async () => {
  // Signature and IHDR of a matching RGBA image, and nothing else.
  const fabricated = Buffer.from(layer.subarray(0, 33));
  expect(fabricated.length).toBe(33);
  await refused(request({ png: fabricated }), "invalid_png");
  records = [];
  const iend = layer.length - 12;
  const truncated = Buffer.concat([layer.subarray(0, 33 + 8 + 10), layer.subarray(iend)]);
  await refused(request({ png: truncated }), "invalid_png");
});

test("a fully transparent layer is not markup and writes nothing", async () => {
  const blank = await refused(request({ png: png(W, H) }), "empty_markup");
  expect(blank.message).toBe("The markup layer is fully transparent: nothing was drawn.");
});

test("a staged layer replaced before it is linked is never published", async () => {
  // Another writer swaps the temporary for its own bytes, or for a link to a policy file.
  for (const swap of ["bytes", "hardlink"] as const) {
    records = [];
    beforeCommit = () => {
      const temp = readdirSync(join(root, dir)).find(name => name.startsWith(".brain-markup-"))!;
      rmSync(join(root, dir, temp));
      if (swap === "bytes") writeFileSync(join(root, dir, temp), png(W, H, { pixel: () => [1, 1, 1, 255] }));
      else linkSync(join(root, "context/policies/crew.md"), join(root, dir, temp));
    };
    const result = await app()(request());
    expect(result.ok, swap).toBe(false);
    expect(result.code).toBe("staging_changed");
    expect(result.changes).toEqual([]);
    expect(layers(), `${swap}: nothing is published`).toEqual([]);
    expect(readFileSync(join(root, "context/policies/crew.md"), "utf8")).toBe("Athena owns these policy bytes.\n");
    for (const name of readdirSync(join(root, dir))) rmSync(join(root, dir, name));
  }
});

test("a markup directory moved after the layer is linked takes the layer with no record of it", async () => {
  afterLink = () => {
    renameSync(join(root, dir), join(root, ".brain/scratch/moved"));
    mkdirSync(join(root, dir));
  };
  const result = await app()(request());
  expect(result.ok).toBe(false); expect(result.code).toBe("topology_changed");
  expect(result.changes).toEqual([]);
  expect(layers()).toEqual([]);
  expect(readdirSync(join(root, ".brain/scratch/moved")).filter(name => name.endsWith(".markup.png")), "the linked name is removed where it went").toEqual([]);
});

test("the byte cap is inclusive: exactly 52,428,800 bytes is written, one more is refused", async () => {
  const ink = { pixel: (x: number) => (x === 3 ? [255, 59, 48, 255] : [0, 0, 0, 0]) as [number, number, number, number] };
  const exact = png(W, H, { ...ink, exactBytes: BRAIN_MARKUP_MAX_BYTES });
  expect(exact.length).toBe(52_428_800);
  const result = await app()(request({ png: exact }));
  expect(result.ok, result.message).toBe(true);
  expect(readFileSync(join(root, result.outcome!.markupPath)).length).toBe(52_428_800);
  records = [];
  const over = png(W, H, { ...ink, exactBytes: BRAIN_MARKUP_MAX_BYTES + 1 });
  const refusal = await refused(request({ png: over }), "payload_too_large");
  expect(refusal.message).toBe("The markup layer is 52428801 bytes; the limit is 52428800 bytes (50 MiB).");
});

test("a source changed while the editor was open refuses", async () => {
  const req = request();
  writeFileSync(join(root, imagePath), png(W, H, { alpha: false, pixel: () => [1, 2, 3, 255] }));
  const result = await app()(req);
  expect(result.code).toBe("stale_base");
  expect(layers()).toEqual([]);
});

test("a source changed after the layer is staged, before it is linked, refuses", async () => {
  beforeCommit = () => writeFileSync(join(root, imagePath), png(W, H, { alpha: false, pixel: () => [9, 9, 9, 255] }));
  const result = await app()(request());
  expect(result.ok).toBe(false); expect(result.code).toBe("stale_base");
  expect(layers()).toEqual([]);
  expect(readdirSync(join(root, dir)).filter(name => name.startsWith(".brain-markup-"))).toEqual([]);
});

test("a symlinked or hard-linked source is refused before the editor opens", () => {
  symlinkSync(join(root, imagePath), join(root, "photos/alias.png"));
  expect(() => readMarkupBase(root, "photos/alias.png")).toThrow("is a symlink");
  linkSync(join(root, imagePath), join(root, "photos/twin.png"));
  expect(() => readMarkupBase(root, imagePath)).toThrow("one link");
});

test.each([
  ["../outside.png", "invalid_target"],
  ["photos/../photos/raft-at-ithaca.png", "invalid_target"],
  [".brain/scratch/raft.png", "invalid_target"],
  ["context/policies/seal.png", "policy_denied"],
  ["photos/raft-notes.md", "invalid_target"],
])("source path %s refuses", (path, code) => {
  expect(() => readMarkupBase(root, path)).toThrow(expect.objectContaining({ code }));
});

test("a source over 16,777,216 pixels is refused before the editor opens", () => {
  // A PNG header claiming 4097 × 4096; no pixel data is needed to read it.
  const big = png(1, 1);
  big.writeUInt32BE(4097, 16); big.writeUInt32BE(4096, 20);
  writeFileSync(join(root, "photos/huge.png"), big);
  expect(() => readMarkupBase(root, "photos/huge.png")).toThrow(/4097x4096, over the 16,777,216-pixel limit/);
});

test("a redirected markup directory writes nothing through it", async () => {
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), join(root, dir));
  await refused(request(), "alias_denied");
  expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
});

test("a redirected scratch area writes nothing through it", async () => {
  rmSync(join(root, ".brain/scratch"), { recursive: true });
  mkdirSync(join(root, "outside-scratch"));
  symlinkSync(join(root, "outside-scratch"), join(root, ".brain/scratch"));
  const result = await app()(request());
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/no markup layer is written there/);
  expect(readdirSync(join(root, "outside-scratch"))).toEqual([]);
});

test("a markup directory swapped during application refuses", async () => {
  beforeCommit = () => {
    renameSync(join(root, dir), join(root, ".brain/scratch/moved"));
    mkdirSync(join(root, dir));
  };
  const result = await app()(request());
  expect(result.ok).toBe(false); expect(result.code).toBe("topology_changed");
  expect(layers()).toEqual([]);
  expect(readdirSync(join(root, ".brain/scratch/moved")).filter(name => !name.startsWith("."))).toEqual([]);
});

test("a scratch area git does not ignore refuses, in the layer's own words", async () => {
  writeFileSync(join(root, ".gitignore"), "");
  const result = await app()(request());
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/not gitignored as a directory, so a markup layer written there could be committed/);
  expect(layers()).toEqual([]);
});

test("a protected markup directory refuses", async () => {
  await refused(request(), "policy_denied", app([".brain/scratch/markup"]));
});

test.each(["principal", "turn", "revoked"])("current markup authority refuses: %s", async kind => {
  const req = request();
  if (kind === "principal") req.principalId = "athena";
  if (kind === "turn") req.turnId = "old-turn";
  if (kind === "revoked") authorized = false;
  await refused(req, "authority_revoked");
});

test("voice membership refuses even with current authority", async () => {
  available = false;
  await refused(request(), "membership_denied");
});

test("cancellation and revocation recheck immediately before the layer is linked", async () => {
  beforeCommit = () => controller.abort();
  await refused(request(), "cancelled");
  records = []; controller = new AbortController();
  beforeCommit = () => { authorized = false; };
  await refused(request(), "authority_revoked");
});
