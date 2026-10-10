// The pack job's table and assertions (scripts/ci-pack.ts), without packing.
// Packing, installing and probing for real is the job itself: CI runs it, and
// `bun run check:pack` runs it locally.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockProblems, missingEntries, packPlan, type PackRow } from "../scripts/ci-pack";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A workspace of Ithaca packages: `palace` depends on `loom`. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-pack-")); roots.push(root);
  for (const [dir, manifest] of Object.entries({
    loom: { name: "@schlessera/brain-loom", version: "1.0.0" },
    palace: { name: "@schlessera/brain-palace", version: "1.0.0", dependencies: { "@schlessera/brain-loom": "workspace:*" } },
    suitors: { name: "@schlessera/brain-suitors", version: "1.0.0", private: true },
  })) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

const valid: Record<string, PackRow> = {
  palace: { files: ["dist/index.js"], bun: ["@schlessera/brain-palace"], node: "bun-only" },
  loom: { files: ["dist/shroud.js"], bun: ["@schlessera/brain-loom/shroud"], node: ["@schlessera/brain-loom/shroud"] },
};

describe("pack plan", () => {
  test("pairs each publishable package with its row, in publish order", () => {
    expect(packPlan(workspace(), valid).map(e => [e.pkg.dir, e.row])).toEqual([["loom", valid.loom], ["palace", valid.palace]]);
  });

  test("refuses a package with no row and a row with no package, naming both", () => {
    const table = { loom: valid.loom!, suitors: valid.palace! };
    expect(() => packPlan(workspace(), table)).toThrow(/packages\/palace has no row[\s\S]*row suitors names no publishable package/);
  });

  test("refuses rows that cannot hold", () => {
    const root = workspace();
    const refuses = (row: PackRow, message: string) =>
      expect(() => packPlan(root, { ...valid, palace: row })).toThrow(message);
    refuses({ ...valid.palace!, bun: ["@schlessera/brain-loom"] }, "palace: @schlessera/brain-loom is not a @schlessera/brain-palace specifier");
    refuses({ ...valid.palace!, node: ["@schlessera/brain-palace-annex"] }, "palace: @schlessera/brain-palace-annex is not a @schlessera/brain-palace specifier");
    refuses({ ...valid.palace!, bun: [] }, "palace: no Bun import");
    refuses({ ...valid.palace!, node: [] }, "palace: no Node import and not bun-only");
    refuses({ ...valid.palace!, files: [] }, "palace: its root is imported but dist/index.js is not a required tarball entry");
    refuses({ files: [], bun: ["@schlessera/brain-palace/hall"], node: "bun-only" }, "dist/index.js is not a required tarball entry");
  });
});

describe("tarball entries", () => {
  const listing = ["package/package.json", "package/dist/index.js", "package/dist/hooks/", "package/skills/loom/SKILL.md"];
  test("a file must be listed exactly", () => {
    expect(missingEntries(listing, ["dist/index.js", "skills/loom/SKILL.md"])).toEqual([]);
    expect(missingEntries(listing, ["dist/index", "dist/index.js.map"])).toEqual(["dist/index", "dist/index.js.map"]);
  });
  test("a directory needs an entry under it, not just itself", () => {
    expect(missingEntries(listing, ["skills/"])).toEqual([]);
    expect(missingEntries(listing, ["dist/hooks/"])).toEqual(["dist/hooks/"]);
  });
});

describe("React 18 lockfile", () => {
  const entries = packPlan(workspace(), valid);
  const packed = `"@schlessera/brain-loom": ["@schlessera/brain-loom@../brainkit-tarballs/loom.tgz", {}],
    "@schlessera/brain-palace": ["@schlessera/brain-palace@../brainkit-tarballs/palace.tgz", {}],`;
  test("every internal package resolves to its tarball", () => {
    expect(lockProblems(packed, entries)).toEqual([]);
  });
  test("a registry copy, nested or not, fails", () => {
    const nested = `${packed}\n    "@schlessera/brain-palace/@schlessera/brain-loom": ["@schlessera/brain-loom@1.0.0", "", {}],`;
    expect(lockProblems(nested, entries)).toEqual(["@schlessera/brain-loom resolved from 1.0.0, not a packed tarball"]);
    expect(lockProblems(packed.replace("../brainkit-tarballs/palace.tgz", "1.0.0"), entries)).toEqual([
      "@schlessera/brain-palace resolved from 1.0.0, not a packed tarball",
      "@schlessera/brain-palace did not resolve to palace.tgz",
    ]);
  });
});
