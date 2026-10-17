import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMounts, captureBuildInputs, captureDerivedOutput, captureOutputs, identity, outputFiles, sameOutputIdentity } from "../scripts/ci-build-boundary";
import { attemptCiBuild } from "../scripts/ci-build-operation";

const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-ci-build-")); owned.push(root);
  for (const path of ["packages/common/src", "node_modules/compiler/dist", "node_modules/.bin"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "packages/common/package.json"), JSON.stringify({ name: "@schlessera/brain-common", version: "0.44.0", bin: { "odysseus-fixture": "dist/cli.js" } }));
  writeFileSync(join(root, "packages/common/src/index.ts"), "export const harbour = 'Ithaca';\n");
  writeFileSync(join(root, "node_modules/compiler/dist/emitter.js"), "export const emitter = 'Odysseus';\n");
  symlinkSync("../../packages/common/dist/cli.js", join(root, "node_modules/.bin/odysseus-fixture"));
  const git = Bun.spawnSync(["git", "init", "--quiet", root], { stdout: "pipe", stderr: "pipe" }); expect(git.exitCode).toBe(0);
  return root;
}
test("captured input bytes survive an original source change and include installed dist", () => {
  const root = fixture(), state = mkdtempSync(join(tmpdir(), "odysseus-ci-input-")); owned.push(state);
  chmodSync(join(root, "packages/common/src/index.ts"), 0o666);
  const mask = process.umask(0o077);
  let captured: ReturnType<typeof captureBuildInputs>;
  try { captured = captureBuildInputs(root, state); } finally { process.umask(mask); }
  writeFileSync(join(root, "packages/common/src/index.ts"), "export const harbour = 'Pylos';\n");
  expect(readFileSync(join(state, "packages/common/src/index.ts"), "utf8"), "CI_BUILD_CONSUMES_CAPTURED_BYTES").toContain("Ithaca");
  expect(statSync(join(state, "packages/common/src/index.ts")).mode & 0o7777, "CI_BUILD_CAPTURE_MODE_IGNORES_HOST_UMASK").toBe(0o666);
  expect(captured.records.some(entry => entry.path === "node_modules/compiler/dist/emitter.js"), "CI_BUILD_TRANSITIVE_INSTALLED_DIST_INCLUDED").toBe(true);
  expect(captured.records.some(entry => entry.path === "node_modules/.bin/odysseus-fixture"), "declared output alias remains an alias, not invented input bytes").toBe(true);
});
test("an effective config alias escaping the captured view refuses eligibility", () => {
  const root = fixture(), outside = mkdtempSync(join(tmpdir(), "odysseus-ci-config-")); owned.push(outside);
  writeFileSync(join(outside, "config.json"), "{}\n"); symlinkSync(join(outside, "config.json"), join(root, "tsconfig.json"));
  const captured = join(outside, "captured");
  expect(() => captureBuildInputs(root, captured), "CI_BUILD_EXTERNAL_CONFIG_REFUSES_REUSE").toThrow("External build input link");
});
test("an undeclared dangling installed alias refuses eligibility", () => {
  const root = fixture(), state = mkdtempSync(join(tmpdir(), "odysseus-ci-input-")); owned.push(state);
  symlinkSync("../compiler/missing.js", join(root, "node_modules/.bin/missing"));
  expect(() => captureBuildInputs(root, state), "CI_BUILD_UNKNOWN_DANGLING_LINK_REFUSES_REUSE").toThrow("Uncaptured build input link target");
});
test("output identity detects deletion, editing, extra files and mode drift", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-ci-output-")); owned.push(root);
  const path = join(root, "cli.js"), bytes = "console.log('Ithaca');\n"; writeFileSync(path, bytes, { mode: 0o755 });
  const original = identity(outputFiles(root));
  for (const change of [() => rmSync(path), () => writeFileSync(path, "console.log('Pylos');\n"), () => writeFileSync(join(root, "extra.js"), bytes), () => chmodSync(path, 0o644)]) {
    expect(sameOutputIdentity(root, original)).toBe(true);
    change(); expect(sameOutputIdentity(root, original), "CI_BUILD_OUTPUT_DRIFT_REFUSES_REUSE").toBe(false);
    rmSync(root, { recursive: true }); mkdirSync(root, { mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o755 });
  }
});
test("validated output capture preserves its checked bytes and modes", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-ci-output-")); owned.push(root);
  const output = join(root, "dist"), captured = join(root, "captured"); mkdirSync(output);
  writeFileSync(join(output, "cli.js"), "console.log('Ithaca');\n", { mode: 0o755 });
  const records = captureOutputs(output, captured);
  writeFileSync(join(output, "cli.js"), "console.log('Pylos');\n");
  expect(readFileSync(join(captured, "cli.js"), "utf8"), "CI_BUILD_PUBLISHES_VALIDATED_BYTES").toContain("Ithaca");
  expect(identity(outputFiles(captured))).toBe(identity(records));
});
test("derived output data and all source leaves are read-only mounts", () => {
  const root = fixture(), state = mkdtempSync(join(tmpdir(), "odysseus-ci-mounts-")); owned.push(state);
  const input = join(state, "input"); captureBuildInputs(root, input);
  const derived = join(state, "derived-common"); mkdirSync(derived); writeFileSync(join(derived, "tokens.css"), ":root{--harbour:Ithaca}");
  const { mounts, topology } = buildMounts(input, state, ["common"], { common: derived });
  expect(mounts.find(mount => mount.target === "/repo/packages/common/dist")?.readonly, "CI_BUILD_DERIVED_OUTPUT_IS_READONLY").toBe(true);
  expect(mounts.filter(mount => mount.target.startsWith("/repo/packages/common/")).every(mount => mount.readonly), "CI_BUILD_SOURCE_LEAVES_ARE_READONLY").toBe(true);
  expect(topology.common).toEqual(["dist", "package.json", "src"]);
  expect(() => buildMounts(input, join(state, "unknown"), ["common"], { missing: derived }), "CI_BUILD_UNDECLARED_DERIVED_INPUT_REFUSED").toThrow("Unknown derived build package");
});
test("derived output changed between identity check and capture refuses consumption", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-ci-derived-")); owned.push(root);
  const source = join(root, "dist"); mkdirSync(source);
  const path = join(source, "tokens.css"), original = ":root{--harbour:Ithaca}"; writeFileSync(path, original);
  const expected = identity(outputFiles(source));
  writeFileSync(path, ":root{--harbour:Pylos}");
  expect(() => captureDerivedOutput(source, join(root, "raced"), expected), "CI_BUILD_DERIVED_CAPTURE_RACE_REFUSES_REUSE").toThrow("Derived build output changed during capture");
  writeFileSync(path, original);
  expect(identity(captureDerivedOutput(source, join(root, "restored"), expected))).toBe(expected);
});
test("CI intent cannot authorize unqualified reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-ci-intent-")); owned.push(root);
  const before = process.env.BRAIN_CI_BUILD_OPERATION;
  try {
    process.env.BRAIN_CI_BUILD_OPERATION = "isolated-v1";
    expect(await attemptCiBuild(root, { jobs: 1, force: false }), "CI_BUILD_INTENT_IS_NOT_AUTHORITY").toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.BRAIN_CI_BUILD_OPERATION; else process.env.BRAIN_CI_BUILD_OPERATION = before;
  }
});
