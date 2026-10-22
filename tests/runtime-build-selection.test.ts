import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeBuildInventory, runtimeBuildSelection } from "../scripts/runtime-test-builds";
import { selectBuildPackages } from "../scripts/publishable-packages";
import { testArgv, testPaths } from "../scripts/test";
const root = resolve(import.meta.dir, "..");

test("every runtime package hook has one inventoried actual forward closure and no boolean bypass", async () => {
  const directory = join(root, "packages/ui-react/tests");
  const hooks = readdirSync(directory).filter(name => name.endsWith(".test.ts") && readFileSync(join(directory, name), "utf8").includes("runtimePackageBuild("));
  expect(hooks).toHaveLength(17);
  expect(hooks.map(name => `packages/ui-react/tests/${name}`).sort()).toEqual(Object.keys(runtimeBuildInventory).sort());
  for (const file of hooks) {
    const text = readFileSync(join(directory, file), "utf8");
    expect(text).not.toMatch(/BRAIN_(?:JOURNAL|ARTIFACT)_DEPENDENCIES_BUILT|BRAIN_AUTH_FIXTURE_BUILT|scripts\/build\.ts/);
    const match = /runtimePackageBuild\([^\n]*?, (\[[^\]]+\])/.exec(text);
    expect(match, file).not.toBeNull();
    const packages = JSON.parse(match![1]!);
    expect(packages, file).toEqual(runtimeBuildInventory[`packages/ui-react/tests/${file}`]);
    const child = Bun.spawn([process.execPath, "scripts/build.ts", "--dry-run", "--for", packages.join(",")], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(0);
    expect(out.trim().split("\n")).toEqual(selectBuildPackages(root, packages).map(pkg => `Would build packages/${pkg.dir}`));
  }
});

test("build selection shares Bun positional parsing without changing test argv", () => {
  const full = ["ui-react", "ui-server", "core"];
  for (const args of [["external-speech"], ["packages/ui-react/tests"], ["./packages"], [join(root, "packages/ui-react/tests/external-speech-runtime.test.ts")], ["--", "external-speech"], ["--changed"], ["--shard=1/4"]]) {
    const argv = testArgv(args);
    expect(selectBuildPackages(root, runtimeBuildSelection(root, root, testPaths(argv))).map(pkg => pkg.dir)).toEqual(selectBuildPackages(root, full).map(pkg => pkg.dir));
  }
  for (const args of [["tests/test-script.test.ts", "-t", "external-speech"], ["tests/test-script.test.ts", "--preload", "external-speech"], ["tests/test-script.test.ts", "--timeout", "180000"], ["does-not-exist.test.ts"]]) {
    expect(testArgv(args)).toEqual(args);
    expect(runtimeBuildSelection(root, root, testPaths(testArgv(args)))).toEqual([]);
  }
  expect(runtimeBuildSelection(root, root, ["share-draft-runtime"])).toEqual(["ui-sdk"]);
  expect(runtimeBuildSelection(root, root, ["haiku-model-runtime"])).toEqual(["ui-react"]);
});
