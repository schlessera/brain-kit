/**
 * The publish artifact check (scripts/check-dist.ts) requires the built file
 * behind every export, read from the manifest. It used to require
 * dist/index.js of every package, which refused brain-common (#1396): that
 * package has no root entry, only `./internal/*` subpaths, and
 * `bun run release -- --dry-run` never runs the check.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertPublishArtifacts, exportedDistFiles } from "../scripts/check-dist";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(exports: Record<string, unknown>, built: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "check-dist-"));
  made.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@odysseus/ithaca", exports }));
  for (const file of built) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "export {};\n");
  }
  return dir;
}

const internalOnly = {
  "./package.json": "./package.json",
  "./internal/env": { bun: "./src/env-core.ts", types: "./dist/env-core.d.ts", default: "./dist/env-core.js" },
  "./internal/frontmatter": {
    bun: "./src/frontmatter-parse.ts",
    types: "./dist/frontmatter-parse.d.ts",
    default: "./dist/frontmatter-parse.js",
  },
};

describe("publish artifacts follow the manifest's exports", () => {
  test("a package with only internal subpaths passes when both are built", () => {
    const dir = fixture(internalOnly, ["dist/env-core.js", "dist/frontmatter-parse.js"]);
    expect(exportedDistFiles(dir).map((file) => file.slice(dir.length + 1)).sort()).toEqual([
      "dist/env-core.js",
      "dist/frontmatter-parse.js",
    ]);
    expect(() => assertPublishArtifacts(dir, "@odysseus/ithaca")).not.toThrow();
  });

  test("a missing subpath build is refused, by name", () => {
    const dir = fixture(internalOnly, ["dist/env-core.js"]);
    expect(() => assertPublishArtifacts(dir, "@odysseus/ithaca")).toThrow(/dist\/frontmatter-parse\.js/);
  });

  test("a root entry is required when the manifest exports one", () => {
    const dir = fixture({ ".": { bun: "./src/index.ts", default: "./dist/index.js" } }, []);
    expect(() => assertPublishArtifacts(dir, "@odysseus/ithaca")).toThrow(/dist\/index\.js/);
  });

  test("a manifest that exports no built entry is refused", () => {
    const dir = fixture({ "./package.json": "./package.json" }, []);
    expect(() => assertPublishArtifacts(dir, "@odysseus/ithaca")).toThrow(/exports no built dist\/ entry/);
  });
});
