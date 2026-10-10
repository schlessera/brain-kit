/**
 * Modules are extension packages: they import core's supported entries only,
 * never `@schlessera/brain/internal` (#1345 ruling, #1397). Their source and
 * their tests both count, so a module's own suite proves the public entry is
 * enough to drive it.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES = join(ROOT, "packages");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sources(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

test("no module package imports @schlessera/brain/internal", () => {
  const modules = readdirSync(PACKAGES).filter((name) => name.startsWith("module-"));
  const files = modules.flatMap((name) => sources(join(PACKAGES, name)));
  expect(modules.length).toBeGreaterThan(0);
  expect(files.length).toBeGreaterThan(modules.length);
  const offenders = files
    .filter((file) => /["']@schlessera\/brain\/internal["']/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file));
  expect(offenders).toEqual([]);
});
