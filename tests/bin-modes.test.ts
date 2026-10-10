import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { binModeProblems, markBinsExecutable } from "../scripts/bin-modes.ts";
import { listPublishablePackages } from "../scripts/publishable-packages.ts";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A one-package workspace whose manifest declares the given bins, each built with `mode`. */
function workspace(bin: Record<string, string>, mode: number, built = true): string {
  const root = mkdtempSync(join(tmpdir(), "bin-modes-"));
  scratch.push(root);
  const dir = join(root, "packages", "ithaca");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@odysseus/ithaca", version: "1.0.0", bin }));
  if (built) for (const target of Object.values(bin)) {
    const file = join(dir, target);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, "#!/usr/bin/env node\n");
    chmodSync(file, mode);
  }
  return root;
}

describe("built bin targets", () => {
  test("a bin target written 0644, as tsc writes it, is reported by path and mode", () => {
    const root = workspace({ "ithaca-watch": "./dist/bin/watch.js" }, 0o644);
    expect(binModeProblems(root)).toEqual(["packages/ithaca/dist/bin/watch.js: mode 644 is not executable"]);
  });

  test("markBinsExecutable makes every declared target executable and keeps the other bits", () => {
    const root = workspace({ "ithaca-watch": "./dist/bin/watch.js", "ithaca-loom": "./dist/cli/loom.js" }, 0o640);
    const [pkg] = listPublishablePackages(root);
    markBinsExecutable(join(root, "packages", "ithaca"), pkg!.manifest);
    expect(binModeProblems(root)).toEqual([]);
    expect(statSync(join(root, "packages/ithaca/dist/bin/watch.js")).mode & 0o777).toBe(0o751);
  });

  test("a declared bin the build did not produce is a problem, and marking it throws", () => {
    const root = workspace({ "ithaca-watch": "./dist/bin/watch.js" }, 0o755, false);
    expect(binModeProblems(root)).toEqual(["packages/ithaca/dist/bin/watch.js: missing"]);
    const [pkg] = listPublishablePackages(root);
    expect(() => markBinsExecutable(join(root, "packages", "ithaca"), pkg!.manifest)).toThrow("ENOENT");
  });

  test("every publishable package's bins come from its manifest, so the real workspace declares some", () => {
    const declared = listPublishablePackages().flatMap(pkg => Object.keys(pkg.manifest.bin ?? {}));
    expect(declared).toEqual(expect.arrayContaining(["brain", "brain-ui-cron", "brain-ui-inbox"]));
  });
});
