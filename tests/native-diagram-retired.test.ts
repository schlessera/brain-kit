// The frozen native diagram qualification is retired (#4105, maintainer ruling
// 2026-11-16). Its pins made every dependency change fail `unit` until a
// manual Docker requalification moved them. Nothing in the scripts or tests
// may pin those identities again: the producer's proof runs fresh in its
// container boundary, and its own run-time checks verify what it mounts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const RETIRED = [
  "e8502b6ffb3c575f2e9a1c93dea8dbf5ceda93ece367da9d542cb10b1c9ac32b", // frozen #2293 source
  "ea866695f2a83f9da2fcf18e75e95e936668ecb28e1449845a2584aa1025b728", // last qualified installation
  "e724696a55955e9f32d396b2031214600086533c3f9b8baabcc1c6bb7311f1db", // pinned ui-kit vitest config
  // The diagram export command's own hash (`f7c3d14c…`) is not listed: the
  // bound-browser-documents audit pins that file independently.
  "c58de06eba788b6b892416ddda3abb28fa1e8e908f25c0800482fbe05e0de678", // pinned ci-proof
];

test("no script or test pins the retired native diagram qualification", () => {
  // Two patterns: Bun's glob matches nothing when a brace alternative holds a `/`.
  const files = ["{scripts,tests}/**/*.{ts,tsx,mjs,js}", "packages/*/{tests,scripts}/**/*.{ts,tsx,mjs,js}"]
    .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root, dot: false })])
    .filter((file) => !file.includes("node_modules") && file !== "tests/native-diagram-retired.test.ts");
  // The scan must see the files the binding lived in, or an empty glob passes vacuously.
  expect(files, "SCAN_COVERS_THE_PROOF_SCRIPTS").toContain("scripts/browser-input-closure.ts");
  const pinned = files.flatMap((file) => RETIRED.filter((hash) => readFileSync(join(root, file), "utf8").includes(hash)).map((hash) => `${file}: ${hash.slice(0, 8)}`));
  expect(pinned, "NATIVE_DIAGRAM_QUALIFICATION_STAYS_RETIRED").toEqual([]);
});
