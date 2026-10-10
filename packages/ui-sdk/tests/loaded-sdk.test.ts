import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertLoadedSdk } from "../src/server";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(version: unknown = "0.3.999") {
  const dir = mkdtempSync(join(tmpdir(), "sdk-manifest-")); scratch.push(dir);
  const ownerManifest = join(dir, "package.json");
  writeFileSync(ownerManifest, JSON.stringify({ name: "fictional-backend", dependencies: { "fictional-sdk": "^0.3.241" } }));
  const sdk = join(dir, "node_modules/fictional-sdk"); mkdirSync(join(sdk, "dist"), { recursive: true });
  const entry = join(sdk, "dist/index.js"); writeFileSync(entry, "export const sdk = true;");
  const sdkManifest = join(sdk, "package.json"); writeFileSync(sdkManifest, JSON.stringify({ name: "fictional-sdk", version }));
  return { ownerManifest, sdkManifest, options: { owner: "fictional-backend", name: "fictional-sdk", ownerManifest: pathToFileURL(ownerManifest), entry, phase: "construction" } };
}
test("metadata cache follows resolved loaded copies and recomposes each host minimum", () => {
  const one = fixture("0.3.282"); const two = fixture("0.3.999");
  expect(assertLoadedSdk(one.options).version).toBe("0.3.282");
  expect(assertLoadedSdk(two.options).version).toBe("0.3.999");
  expect(() => assertLoadedSdk({ ...one.options, minimum: "0.3.283" })).toThrow(/incompatible.*detected "0\.3\.282"/);
  expect(assertLoadedSdk({ ...two.options, minimum: "0.3.283" }).version).toBe("0.3.999");
});
for (const failure of ["missing", "unreadable", "wrong-name", "missing-version", "malformed-version"] as const) {
  test(`loaded manifest ${failure} refuses with owner, requirement, phase and action`, () => {
    const f = fixture();
    if (failure === "missing") rmSync(f.sdkManifest);
    if (failure === "unreadable") { rmSync(f.sdkManifest); mkdirSync(f.sdkManifest); } // deterministic EISDIR, including privileged test users
    if (failure === "wrong-name") writeFileSync(f.sdkManifest, JSON.stringify({ name: "other-sdk", version: "0.3.999" }));
    if (failure === "missing-version") writeFileSync(f.sdkManifest, JSON.stringify({ name: "fictional-sdk" }));
    if (failure === "malformed-version") writeFileSync(f.sdkManifest, JSON.stringify({ name: "fictional-sdk", version: "0.3" }));
    expect(() => assertLoadedSdk(f.options)).toThrow(/fictional-backend SDK.*construction.*detected.*requirements: fictional-backend range "\^0\.3\.241".*Install/);
  });
}
for (const failure of ["missing", "unreadable", "wrong-name", "missing-range", "malformed-range"] as const) {
  test(`owning manifest ${failure} cannot silently omit its dependency requirement`, () => {
    const f = fixture();
    if (failure === "missing") rmSync(f.ownerManifest);
    if (failure === "unreadable") { rmSync(f.ownerManifest); mkdirSync(f.ownerManifest); }
    if (failure === "wrong-name") writeFileSync(f.ownerManifest, JSON.stringify({ name: "other-backend" }));
    if (failure === "missing-range") writeFileSync(f.ownerManifest, JSON.stringify({ name: "fictional-backend" }));
    if (failure === "malformed-range") writeFileSync(f.ownerManifest, JSON.stringify({ name: "fictional-backend", dependencies: { "fictional-sdk": "0.3.broken" } }));
    expect(() => assertLoadedSdk(f.options)).toThrow(/fictional-backend.*fictional-sdk.*construction.*detected.*Install/);
  });
}
