/**
 * A mask beside an image in the scratch area (#310) lands in scratch too,
 * and is held to its rules: git must exclude the directory, a symlinked
 * scratch is refused, the write never goes through a planted link, and the
 * host's prune runs afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  assertScratchMask,
  claudeMaskFilename,
  claudeReportedMaskPath,
  handleRequestImageMask,
  writeScratchMask,
} from "../src/server/bridge-tools/mask";
import type { BackendBridge } from "../src/server/backend";

let root: string;
const SCRATCH = ".brain/scratch";
const outsides: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-mask-scratch-"));
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  mkdirSync(join(root, SCRATCH), { recursive: true });
  writeFileSync(join(root, SCRATCH, "draft.png"), "png");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "photo.png"), "png");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const dir of outsides.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ignore = () => writeFileSync(join(root, ".gitignore"), "node_modules\n.brain/scratch/\n");

function bridgeWith(pruned: number[]): BackendBridge {
  return {
    requestMask: async () => new Uint8Array([1, 2, 3]),
    pruneScratch: async () => {
      pruned.push(Date.now());
    },
  } as unknown as BackendBridge;
}

const mask = (imagePath: string, bridge: BackendBridge = bridgeWith([])) =>
  handleRequestImageMask(
    { imagePath, instruction: "the sky" },
    bridge,
    { brainPath: root, maskFilename: claudeMaskFilename, reportMaskPath: claudeReportedMaskPath }
  );

describe("request_image_mask into scratch", () => {
  test("refuses while the scratch directory is not gitignored, naming the fix, and writes nothing", async () => {
    await expect(mask(`${SCRATCH}/draft.png`)).rejects.toThrow(/not gitignored as a directory.*brain doctor --fix/s);
    expect(existsSync(join(root, SCRATCH, "draft-mask.png"))).toBe(false);
  });

  test("a rule that excludes the files but not the directory is refused too", async () => {
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/*\n!.brain/scratch/draft-mask.png\n");
    await expect(mask(`${SCRATCH}/draft.png`)).rejects.toThrow(/not gitignored as a directory/);
    expect(existsSync(join(root, SCRATCH, "draft-mask.png"))).toBe(false);
  });

  test("once ignored, the mask lands beside the draft, and the host's prune runs", async () => {
    ignore();
    const pruned: number[] = [];
    const payload = await mask(`${SCRATCH}/draft.png`, bridgeWith(pruned));
    expect(payload.maskPath).toBe(`${SCRATCH}/draft-mask.png`);
    expect(readFileSync(join(root, SCRATCH, "draft-mask.png"))).toEqual(Buffer.from([1, 2, 3]));
    expect(pruned).toHaveLength(1);
    expect(readdirSync(join(root, SCRATCH)).sort()).toEqual(["draft-mask.png", "draft.png"]);
  });

  test("a mask outside scratch is not its business, and does not prune", async () => {
    const pruned: number[] = [];
    const payload = await mask("assets/photo.png", bridgeWith(pruned));
    expect(payload.maskPath).toBe("assets/photo-mask.png");
    expect(existsSync(join(root, "assets", "photo-mask.png"))).toBe(true);
    expect(pruned).toHaveLength(0);
  });

  test("a symlinked scratch is refused even when ignored", () => {
    ignore();
    rmSync(join(root, SCRATCH), { recursive: true, force: true });
    symlinkSync(join("..", "assets"), join(root, SCRATCH));
    const rootReal = realpathSync(root);
    expect(() =>
      assertScratchMask(rootReal, `${SCRATCH}/draft-mask.png`, join(rootReal, "assets", "draft-mask.png"))
    ).toThrow(/redirected by a symlink/);
  });

  test("a planted link at the mask's name is refused, and its target is untouched", async () => {
    // A link out of the brain is already refused by containment; one to a
    // content file inside it is contained, and is the case the write
    // primitive exists for: writing through it would overwrite content.
    ignore();
    const victim = join(root, "assets", "photo.png");
    writeFileSync(victim, "keep me");
    symlinkSync(join("..", "..", "assets", "photo.png"), join(root, SCRATCH, "draft-mask.png"));
    // Canonicalized, the name is the content file: refused as resolving out of scratch.
    await expect(mask(`${SCRATCH}/draft.png`)).rejects.toThrow(/resolves outside \.brain\/scratch/);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(readlinkSync(join(root, SCRATCH, "draft-mask.png"))).toBe(join("..", "..", "assets", "photo.png"));
  });

  test("a nested directory swapped for a link before the write is refused, and nothing lands outside", () => {
    ignore();
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    outsides.push(outside);
    const rootReal = realpathSync(root);
    symlinkSync(outside, join(root, SCRATCH, "nested"));
    expect(() => writeScratchMask(rootReal, join(rootReal, SCRATCH, "nested", "x-mask.png"), new Uint8Array([1]))).toThrow(
      /not a directory of its own/
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  test("outside a git repository the ignore line is required all the same, and a later negation cancels it", () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    const rootReal = realpathSync(root);
    const target = join(rootReal, SCRATCH, "draft-mask.png");
    expect(() => assertScratchMask(rootReal, `${SCRATCH}/draft-mask.png`, target)).toThrow(/not gitignored/);
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
    expect(() => assertScratchMask(rootReal, `${SCRATCH}/draft-mask.png`, target)).not.toThrow();
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n!.brain/scratch/\n");
    expect(() => assertScratchMask(rootReal, `${SCRATCH}/draft-mask.png`, target)).toThrow(/not gitignored/);
  });
});
