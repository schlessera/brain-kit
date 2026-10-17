import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildDecision, buildInputs, recordBuild, stampPath } from "../scripts/build-stamp.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A two-package Odysseus workspace whose dist each "build" writes by hand. */
function fixture(git = true): string {
  const root = mkdtempSync(join(tmpdir(), "odysseus-build-stamp-"));
  roots.push(root);
  if (git) expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  write(root, ".gitignore", "dist/\nnode_modules/\npackages/*/dist/\n");
  write(root, "package.json", JSON.stringify({ name: "odysseus-workspace", private: true }));
  write(root, "bun.lock", "{}\n");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { customConditions: ["bun"] } }));
  for (const name of ["ithaca", "troy"]) {
    write(root, `packages/${name}/package.json`, JSON.stringify({ name: `@odysseus/${name}`, version: "1.0.0" }));
    write(root, `packages/${name}/src/index.ts`, `export const harbour = "${name}";\n`);
  }
  return root;
}

function build(root: string, name: string, input: string | undefined, text = `export const harbour = "${name}";\n`) {
  rmSync(join(root, "packages", name, "dist"), { recursive: true, force: true });
  write(root, `packages/${name}/dist/index.js`, text);
  recordBuild(root, name, input);
}

describe("workspace build stamp", () => {
  test("an unchanged second build is up to date and leaves dist untouched", () => {
    const root = fixture();
    const input = buildInputs(root);
    expect(input).toMatch(/^[0-9a-f]{64}$/);
    for (const name of ["ithaca", "troy"]) build(root, name, input);
    expect(buildInputs(root)).toBe(input!);
    for (const name of ["ithaca", "troy"]) expect(buildDecision(root, name, input, false)).toBe("up-to-date");
  });

  test("any package source edit, new file or root build input rebuilds every package", () => {
    const root = fixture();
    const input = buildInputs(root);
    for (const name of ["ithaca", "troy"]) build(root, name, input);
    const changes: [string, () => void][] = [
      ["a sibling's source", () => write(root, "packages/troy/src/index.ts", 'export const harbour = "wooden horse";\n')],
      ["a new untracked source file", () => write(root, "packages/troy/src/gift.ts", "export const gift = 1;\n")],
      ["the root tsconfig", () => write(root, "tsconfig.json", "{}\n")],
      ["the lockfile", () => write(root, "bun.lock", '{"lockfileVersion":2}\n')],
    ];
    let previous = input;
    for (const [label, change] of changes) {
      change();
      const next = buildInputs(root);
      expect(next, label).not.toBe(previous!);
      for (const name of ["ithaca", "troy"]) expect(buildDecision(root, name, next, false), `${label} → ${name}`).toBe("build");
      previous = next;
    }
  });

  test("a different runtime version is a different input", () => {
    const root = fixture();
    expect(buildInputs(root, "1.4.2")).not.toBe(buildInputs(root, "1.4.3")!);
  });

  test("an ignored file does not change the inputs", () => {
    const root = fixture();
    const input = buildInputs(root);
    write(root, "packages/ithaca/dist/notes.txt", "Penelope's loom\n");
    write(root, "packages/ithaca/node_modules/x/index.js", "1\n");
    expect(buildInputs(root)).toBe(input!);
  });

  test("a deleted, edited or extra dist file rebuilds only that package", () => {
    const root = fixture();
    const input = buildInputs(root);
    const damage: [string, () => void][] = [
      ["deleted", () => rmSync(join(root, "packages/ithaca/dist/index.js"))],
      ["edited", () => write(root, "packages/ithaca/dist/index.js", "export const harbour = 'Ogygia';\n")],
      ["extra", () => write(root, "packages/ithaca/dist/stale.js", "export {};\n")],
    ];
    for (const [label, change] of damage) {
      for (const name of ["ithaca", "troy"]) build(root, name, input);
      expect(buildDecision(root, "ithaca", input, false), `${label} before`).toBe("up-to-date");
      change();
      expect(buildDecision(root, "ithaca", input, false), `${label} dist`).toBe("build");
      expect(buildDecision(root, "troy", input, false), `${label} sibling`).toBe("up-to-date");
    }
  });

  test("--force always rebuilds", () => {
    const root = fixture();
    const input = buildInputs(root);
    build(root, "ithaca", input);
    expect(buildDecision(root, "ithaca", input, true)).toBe("build");
  });

  test("a stamp copied into another checkout without dist does not skip", () => {
    const root = fixture();
    const input = buildInputs(root);
    build(root, "ithaca", input);
    const copy = fixture();
    cpSync(join(root, "node_modules"), join(copy, "node_modules"), { recursive: true });
    expect(Bun.file(stampPath(copy, "ithaca")).size).toBeGreaterThan(0);
    expect(buildInputs(copy)).toBe(input!);
    expect(buildDecision(copy, "ithaca", buildInputs(copy), false)).toBe("build");
  });

  test("without a Git checkout the inputs are unknown and nothing skips", () => {
    const root = fixture(false);
    const input = buildInputs(root);
    expect(input).toBeUndefined();
    build(root, "ithaca", input);
    expect(Bun.file(stampPath(root, "ithaca")).size).toBe(0);
    expect(buildDecision(root, "ithaca", input, false)).toBe("build");
  });

  test("a malformed or foreign stamp rebuilds", () => {
    const root = fixture();
    const input = buildInputs(root);
    build(root, "ithaca", input);
    for (const text of ["not json", JSON.stringify({ version: 0, input, output: "x" }), JSON.stringify({ version: 1, input: "other", output: "x" })]) {
      writeFileSync(stampPath(root, "ithaca"), text);
      expect(buildDecision(root, "ithaca", input, false)).toBe("build");
    }
  });
});
