import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_ASSET_SPECIFIER, BRAND_MASTERS, BRAND_RASTERS } from "../src/brand.js";

const PACKAGE = join(import.meta.dir, "..");
const ASSETS = join(PACKAGE, "assets", "brand");

/**
 * SHA-256 of each master in the archive the maintainer accepted on #1423
 * (archive SHA-256 402fc1e8e5aa378944f16b8850509b70df42317231cbe5b07a4d0020047c1224).
 * A master is replaced only by a new accepted design, never edited in place.
 */
const ACCEPTED: Record<string, string> = {
  "apple-touch-icon.svg": "55d739b83f3c697b22b0706b559a47ed76f0512a36cbcf134a2def97d11c2b34",
  "favicon.svg": "a21cb9fb2fa7023af7147dd4aa299db47bb68751b7542539cad756b9d67a414c",
  "icon-512.svg": "55f179d97da6c696d692861819b86e4a1bb836827beeb4f0a474ecfe30681bd1",
  "lockup-on-dark.svg": "fcab4851ffa18aa00c2a893fe644a0068eca7c552751540e7185b91c3e5ef65d",
  "lockup-on-paper.svg": "522967a4de7fbb5633df9ff2ee7c3db3ff97ba919876937083ce2e1426a5b611",
  "mark-mono-dark.svg": "3b7febb66fe14742ef4c62df76f500bc04111a218c3d373798a3f63337ad2799",
  "mark-mono-paper.svg": "ed2024682a604131f6b921bee24c91284377c44a58e3d808a5567fe11c35f110",
  "mark-on-dark.svg": "cedd75316f79d6a334cb6984da787b2d17fc0b01b7e7b352a4d84279340ba383",
  "mark-on-paper.svg": "04fb87c0976d8fc441518c3fdfa7aa250ad8cef91afdfd296f23b4609dfa46d5",
  "mark-reversed.svg": "6b0198afb2db13ef05e07e22e1a4e60d17fa51dc13fa458a07b3cb4ba9fb4c36",
  "mark-small-on-dark.svg": "bfc51b9789678e48d7b81d9709168b7a7a5b9c6229d2775e5919f96f6bd4697b",
  "mark-small-on-paper.svg": "7ec24b58a7e88eaa68585e0e1fd18658ac5f3afaf6abc25ffe162d745cf9bb5d",
  "maskable-512.svg": "5267331063562851ed14f8eab9e9242e58149b8b0db775c62dad9b610e7c1c54",
  "social-card.svg": "fde7f4b6faef0ca4e1e5628218a601563dd640ca2c0cbf79ffb5ac858b2f0f74",
};

const SHIPPED: readonly string[] = [...BRAND_MASTERS, ...BRAND_RASTERS];

describe("brand masters", () => {
  test("the committed masters are exactly the accepted files", () => {
    expect(Object.keys(ACCEPTED).length).toBe(14);
    expect([...BRAND_MASTERS].sort() as string[]).toEqual(Object.keys(ACCEPTED).sort());
    for (const [file, sha] of Object.entries(ACCEPTED)) {
      const got = createHash("sha256").update(readFileSync(join(ASSETS, file))).digest("hex");
      expect(got, file).toBe(sha);
    }
  });

  test("the brand directory holds the listed files and nothing else", () => {
    expect(readdirSync(ASSETS).sort()).toEqual([...SHIPPED].sort());
  });
});

// The tarball itself is checked by CI's pack job, which packs this package
// with `bun pm pack`, greps for every brand file and resolves each one from an
// installed consumer (`.github/workflows/ci.yml`). The test preload cannot run
// `bun pm` (it puts `--preload` ahead of the subcommand), so these assertions
// hold the two manifest fields that job depends on.
describe("brand files are declared for publishing", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
    name: string;
    files: string[];
    exports: Record<string, unknown>;
  };

  test("the package publishes the assets directory", () => {
    expect(manifest.files).toContain("assets");
  });

  test("every file resolves through the declared export to the committed bytes", () => {
    expect(manifest.exports["./brand/*"]).toBe("./assets/brand/*");
    expect(SHIPPED.length).toBeGreaterThan(0);
    for (const file of SHIPPED) {
      // A self-reference: resolution goes through the package's exports map.
      const resolved = Bun.resolveSync(`${BRAND_ASSET_SPECIFIER}${file}`, PACKAGE);
      expect(resolved, file).toBe(join(ASSETS, file));
    }
  });
});
