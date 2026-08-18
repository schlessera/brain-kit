import { describe, expect, test } from "bun:test";
import {
  SHARE_OPTIMIZED,
  alreadyWithinTarget,
  formatBytes,
  optimizationLadder,
  optimizedFilename,
} from "../src/lib/image-optimize.js";

describe("optimizationLadder", () => {
  test("first attempt is the most faithful one that respects maxEdge", () => {
    const [first] = optimizationLadder(4096, 2048);
    expect(first).toEqual({ width: 2048, height: 1024, quality: 0.85 });
  });

  test("an image already within maxEdge is never upscaled", () => {
    const [first] = optimizationLadder(800, 600);
    expect(first!.width).toBe(800);
    expect(first!.height).toBe(600);
  });

  test("aspect ratio survives every step", () => {
    for (const step of optimizationLadder(3000, 1000)) {
      expect(step.width / step.height).toBeCloseTo(3, 1);
    }
  });

  test("quality descends within a size before the size drops", () => {
    const steps = optimizationLadder(4096, 4096);
    const firstSize = steps.filter((s) => s.width === steps[0]!.width);
    expect(firstSize.map((s) => s.quality)).toEqual([0.85, 0.72, 0.6]);
    // The next group is half the edge, not another pass at the same size.
    const next = steps.find((s) => s.width !== steps[0]!.width);
    expect(next!.width).toBe(steps[0]!.width / 2);
  });

  test("stops shrinking before the image stops being worth sending", () => {
    const steps = optimizationLadder(600, 400);
    const smallest = Math.min(...steps.map((s) => Math.max(s.width, s.height)));
    expect(smallest).toBeGreaterThanOrEqual(150);
  });

  test("degenerate sizes still produce at least one usable step", () => {
    const steps = optimizationLadder(1, 1);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]).toEqual({ width: 1, height: 1, quality: 0.85 });
  });

  test("honors a custom target", () => {
    const [first] = optimizationLadder(1000, 500, { maxEdge: 100, maxBytes: 1000 });
    expect(first).toEqual({ width: 100, height: 50, quality: 0.85 });
  });
});

describe("alreadyWithinTarget", () => {
  test("true only when both bytes and edges are inside the target", () => {
    expect(alreadyWithinTarget(500_000, 1024, 768)).toBe(true);
    // Small file, oversized pixels: still worth re-encoding for a share.
    expect(alreadyWithinTarget(500_000, 4096, 768)).toBe(false);
    // Modest pixels, heavy file.
    expect(alreadyWithinTarget(5_000_000, 1024, 768)).toBe(false);
  });

  test("boundary values count as within", () => {
    expect(
      alreadyWithinTarget(SHARE_OPTIMIZED.maxBytes, SHARE_OPTIMIZED.maxEdge, 10)
    ).toBe(true);
    expect(
      alreadyWithinTarget(SHARE_OPTIMIZED.maxBytes + 1, SHARE_OPTIMIZED.maxEdge, 10)
    ).toBe(false);
  });
});

describe("optimizedFilename", () => {
  test("swaps a known image extension for .jpg", () => {
    expect(optimizedFilename("render.png")).toBe("render.jpg");
    expect(optimizedFilename("photo.JPEG")).toBe("photo.jpg");
    expect(optimizedFilename("sticker.webp")).toBe("sticker.jpg");
  });

  test("leaves the rest of the name alone, dots included", () => {
    expect(optimizedFilename("2026-08-17.plan.v2.png")).toBe("2026-08-17.plan.v2.jpg");
  });

  test("adds an extension when there was none", () => {
    expect(optimizedFilename("image")).toBe("image.jpg");
  });
});

describe("formatBytes", () => {
  test("scales the unit to the magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(2_600_000)).toBe("2.5 MB");
  });
});
