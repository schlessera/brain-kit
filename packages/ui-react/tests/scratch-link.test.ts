// A chat link to a file in the brain's scratch area (#310) is a file link the
// app opens in its viewer, the same as any other repo path. A path under the
// system temp directory is not: the viewer could never serve it.
import { describe, expect, test } from "bun:test";

import { classifyRepoPath } from "../src/stores/file-state.js";

describe("links into the scratch area", () => {
  test("a scratch file is a file link", () => {
    expect(classifyRepoPath(".brain/scratch/trip.pdf")).toBe("file");
    expect(classifyRepoPath(".brain/scratch/render-2026-09-24T12-00-00-000Z.png")).toBe("file");
  });

  test("an absolute temp path is not a repo link", () => {
    expect(classifyRepoPath("/tmp/trip.pdf")).toBeNull();
  });
});
