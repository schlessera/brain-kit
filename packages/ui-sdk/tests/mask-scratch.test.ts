/**
 * A mask beside an image in the scratch area (#310) lands in scratch too,
 * and is held to its rules: git must ignore the target, and a symlinked
 * scratch is refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  assertScratchMask,
  claudeMaskFilename,
  claudeReportedMaskPath,
  handleRequestImageMask,
} from "../src/server/bridge-tools/mask";
import type { BackendBridge } from "../src/server/backend";

let root: string;
const SCRATCH = ".brain/scratch";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-mask-scratch-"));
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  mkdirSync(join(root, SCRATCH), { recursive: true });
  writeFileSync(join(root, SCRATCH, "draft.png"), "png");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "photo.png"), "png");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bridge = {
  requestMask: async () => new Uint8Array([1, 2, 3]),
} as unknown as BackendBridge;

const mask = (imagePath: string) =>
  handleRequestImageMask(
    { imagePath, instruction: "the sky" },
    bridge,
    { brainPath: root, maskFilename: claudeMaskFilename, reportMaskPath: claudeReportedMaskPath }
  );

describe("request_image_mask into scratch", () => {
  test("refuses while scratch is not gitignored, naming the fix, and writes nothing", async () => {
    await expect(mask(`${SCRATCH}/draft.png`)).rejects.toThrow(/draft-mask\.png is not gitignored.*brain doctor --fix/s);
    expect(existsSync(join(root, SCRATCH, "draft-mask.png"))).toBe(false);
  });

  test("once ignored, the mask lands beside the draft", async () => {
    writeFileSync(join(root, ".gitignore"), "node_modules\n.brain/scratch/\n");
    const payload = await mask(`${SCRATCH}/draft.png`);
    expect(payload.maskPath).toBe(`${SCRATCH}/draft-mask.png`);
    expect(existsSync(join(root, SCRATCH, "draft-mask.png"))).toBe(true);
  });

  test("a mask outside scratch is not its business", async () => {
    const payload = await mask("assets/photo.png");
    expect(payload.maskPath).toBe("assets/photo-mask.png");
    expect(existsSync(join(root, "assets", "photo-mask.png"))).toBe(true);
  });

  test("a symlinked scratch is refused even when ignored", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules\n.brain/scratch/\n");
    rmSync(join(root, SCRATCH), { recursive: true, force: true });
    symlinkSync(join("..", "assets"), join(root, SCRATCH));
    const rootReal = realpathSync(root);
    expect(() =>
      assertScratchMask(rootReal, `${SCRATCH}/draft-mask.png`, join(rootReal, "assets", "draft-mask.png"))
    ).toThrow(/redirected by a symlink/);
  });

  test("outside a git repository the ignore line is required all the same", () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    const rootReal = realpathSync(root);
    const target = join(rootReal, SCRATCH, "draft-mask.png");
    expect(() => assertScratchMask(rootReal, `${SCRATCH}/draft-mask.png`, target)).toThrow(/not gitignored/);
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
    expect(() => assertScratchMask(rootReal, `${SCRATCH}/draft-mask.png`, target)).not.toThrow();
  });
});
