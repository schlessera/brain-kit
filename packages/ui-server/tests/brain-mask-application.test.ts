import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAIN_MASK_MAX_BYTES, createKeyedLock, type BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import { createMaskApplication, readMaskBase } from "../src/brain/mask-application.js";

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
let root: string, controller: AbortController, authorized: boolean, available: boolean;
let records: BrainApplicationResult[], beforeCommit: (() => void) | undefined;
const imagePath = "assets/raft.png", maskPath = "assets/raft-mask.png";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-mask-"));
  mkdirSync(join(root, "assets")); mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, imagePath), png);
  writeFileSync(join(root, "context/policies/crew.md"), "Athena owns these policy bytes.\n");
  controller = new AbortController(); authorized = true; available = true; records = []; beforeCommit = undefined;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function app() {
  return createMaskApplication({ root, principalId: "odysseus", turnId: "raft-turn", signal: controller.signal,
    lock: createKeyedLock(), isAuthorized: () => authorized, isAvailable: () => available,
    record: result => records.push(result), beforeCommit: () => beforeCommit?.() });
}
function request(overrides: Record<string, unknown> = {}) {
  return { principalId: "odysseus", turnId: "raft-turn", base: readMaskBase(root, imagePath), input: { imagePath, maskPath, png }, ...overrides };
}
async function refused(req: ReturnType<typeof request>, code: string) {
  const entries = readdirSync(join(root, "context/policies"));
  const result = await app()(req);
  expect(result.ok).toBe(false); expect(result.code).toBe(code); expect(result.changes).toEqual([]);
  expect(existsSync(join(root, maskPath)), "refused operation creates no mask").toBe(false);
  expect(readFileSync(join(root, "context/policies/crew.md"), "utf8")).toBe("Athena owns these policy bytes.\n");
  expect(readdirSync(join(root, "context/policies"))).toEqual(entries);
  expect(existsSync(join(root, "assets/other.png"))).toBe(false);
  expect(records).toEqual([result]);
}
test("PNG mask preserves exact bytes, filename and actual-effect history", async () => {
  const result = await app()(request());
  expect(result.ok).toBe(true); expect(readFileSync(join(root, maskPath))).toEqual(png);
  expect(result.changes).toEqual([{ path: maskPath, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(result.outcome?.maskPath).toBe(maskPath); expect(records).toEqual([result]);
});
test("non-PNG bytes refuse without an effect", async () => {
  await refused(request({ input: { imagePath, maskPath, png: Buffer.from("not PNG") } }), "invalid_png");
});
test("oversized PNG bytes refuse without an effect", async () => {
  const huge = Buffer.alloc(BRAIN_MASK_MAX_BYTES + 1); png.copy(huge);
  await refused(request({ input: { imagePath, maskPath, png: huge } }), "payload_too_large");
});
test("a path outside the submitted image mask shape refuses without an effect", async () => {
  await refused(request({ input: { imagePath, maskPath: "assets/other.png", png } }), "invalid_target");
});
test.each(["principal", "turn", "revoked"])("current mask authority refuses: %s", async kind => {
  const req = request();
  if (kind === "principal") req.principalId = "athena";
  if (kind === "turn") req.turnId = "old-turn";
  if (kind === "revoked") authorized = false;
  await refused(req, "authority_revoked");
});
test("voice membership refuses even with current authority", async () => { available = false; await refused(request(), "membership_denied"); });
test("cancellation rechecks immediately before the actual PNG effect", async () => {
  beforeCommit = () => controller.abort(); await refused(request(), "cancelled");
});
test("authority and membership recheck after lock admission", async () => {
  beforeCommit = () => { authorized = false; }; await refused(request(), "authority_revoked");
});
test("a stale image or previous mask refuses overwrite", async () => {
  const req = request(); writeFileSync(join(root, imagePath), "changed image"); await refused(req, "stale_base");
});
test("mask hardlink and symlink aliases cannot change policy", async () => {
  for (const alias of [linkSync, symlinkSync]) {
    alias(join(root, "context/policies/crew.md"), join(root, maskPath));
    expect(() => readMaskBase(root, imagePath)).toThrow();
    expect(readFileSync(join(root, "context/policies/crew.md"), "utf8")).toBe("Athena owns these policy bytes.\n");
    rmSync(join(root, maskPath));
  }
});
test("directory topology swap refuses the descriptor-anchored mask effect", async () => {
  beforeCommit = () => { renameSync(join(root, "assets"), join(root, "old-assets")); symlinkSync(join(root, "context/policies"), join(root, "assets")); };
  await refused(request(), "topology_changed");
  expect(readdirSync(join(root, "old-assets"))).toEqual(["raft.png"]);
});
test("scratch mask prunes under the same authority and records actual removals", async () => {
  mkdirSync(join(root, ".brain/scratch"), { recursive: true }); writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
  const imagePath = ".brain/scratch/raft.png", maskPath = ".brain/scratch/raft-mask.png";
  writeFileSync(join(root, imagePath), png); writeFileSync(join(root, ".brain/scratch/old.png"), png);
  utimesSync(join(root, ".brain/scratch/old.png"), new Date(0), new Date(0));
  const result = await app()({ principalId: "odysseus", turnId: "raft-turn", base: readMaskBase(root, imagePath), input: { imagePath, maskPath, png } });
  expect(result.ok).toBe(true); expect(readFileSync(join(root, maskPath))).toEqual(png);
  expect(result.changes).toContainEqual({ path: ".brain/scratch/old.png", contentHash: null });
  expect(existsSync(join(root, ".brain/scratch/old.png"))).toBe(false); expect(records).toEqual([result]);
});

test.each([
  ["traversal", "assets/../assets/raft.png", "invalid_target"],
  ["policy", "context/policies/crew.png", "policy_denied"],
  ["metadata", ".git/raft.png", "invalid_target"],
])("mask source path guard: %s", async (_, imagePath, code) => {
  if (imagePath === "context/policies/crew.png") writeFileSync(join(root, imagePath), png);
  if (imagePath === ".git/raft.png") { mkdirSync(join(root, ".git")); writeFileSync(join(root, imagePath), png); }
  const maskPath = imagePath.replace(/\.png$/, "-mask.png");
  await refused({ principalId: "odysseus", turnId: "raft-turn", base: readMaskBase(root, "assets/raft.png"), input: { imagePath, maskPath, png } }, code);
});
test("non-image source and missing image refuse", () => {
  writeFileSync(join(root, "assets/raft.txt"), png);
  expect(() => readMaskBase(root, "assets/raft.txt")).toThrow("submitted image");
  expect(() => readMaskBase(root, "assets/missing.png")).toThrow("does not exist");
});
test("unexpected mask request keys refuse", async () => {
  await refused(request({ input: { imagePath, maskPath, png, command: "ignored" } }), "invalid_request");
});
test("a stale previous mask refuses and preserves its bytes", async () => {
  const req = request(); writeFileSync(join(root, maskPath), png);
  const result = await app()(req);
  expect(result.ok).toBe(false); expect(result.code).toBe("stale_base"); expect(result.changes).toEqual([]);
  expect(readFileSync(join(root, maskPath))).toEqual(png);
});
test("validated PNG bytes are owned before lock admission", async () => {
  const bytes = Uint8Array.from(png);
  const apply = createMaskApplication({ root, principalId: "odysseus", turnId: "raft-turn", signal: controller.signal,
    isAuthorized: () => authorized, isAvailable: () => available, record: result => records.push(result),
    lock: { async withLock(_key, fn) { bytes.fill(0); return fn(); } } });
  const result = await apply(request({ input: { imagePath, maskPath, png: bytes } }));
  expect(result.ok).toBe(true); expect(readFileSync(join(root, maskPath)), "application writes the validated owned PNG").toEqual(png);
});
test("mask membership is rechecked immediately before commit", async () => {
  beforeCommit = () => { available = false; }; await refused(request(), "membership_denied");
});

test("mask base reader independently refuses traversal before resolving a mask shape", () => {
  expect(() => readMaskBase(root, "assets/../assets/raft.png")).toThrow("without traversal");
});

test("trusted pi mask identity refuses the Claude filename and accepts only the pi filename", async () => {
  const apply = createMaskApplication({ root, backend: "pi", principalId: "odysseus", turnId: "raft-turn", signal: controller.signal,
    lock: createKeyedLock(), isAuthorized: () => authorized, isAvailable: () => available, record: result => records.push(result) });
  const base = readMaskBase(root, imagePath, "pi");
  const wrong = await apply({ ...request(), base });
  expect(wrong.code, "worker input cannot select the other adapter's filename").toBe("invalid_target");
  expect(existsSync(join(root, maskPath))).toBe(false);
  const result = await apply({ ...request(), base, input: { imagePath, maskPath: "assets/raft.mask.png", png } });
  expect(result.ok).toBe(true);
  expect(readFileSync(join(root, "assets/raft.mask.png"))).toEqual(png);
});
