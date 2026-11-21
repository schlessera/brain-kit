/**
 * The gog transport's module boundary (#4205): a Bun-only entry point of its
 * own, beside the pure google-operations module, which never imports it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import * as entry from "@schlessera/brain-common/internal/google-gog";

const PACKAGE = resolve(import.meta.dir, "..");
const GOOGLE = join(PACKAGE, "src/google");
const GOG = join(GOOGLE, "gog");
const BUILTINS = new Set(builtinModules);
const transpiler = new Bun.Transpiler({ loader: "ts" });
const tsFiles = (dir: string) => readdirSync(dir).filter(name => name.endsWith(".ts")).map(name => join(dir, name));
const importsOf = (file: string) => transpiler.scanImports(readFileSync(file, "utf8")).map(({ path }) => path);

describe("@schlessera/brain-common/internal/google-gog", () => {
  test("imports only its own files, the operations module, zod and Node built-ins: no other package", () => {
    const outside = tsFiles(GOG).flatMap(file => importsOf(file).flatMap(path => {
      if (path.startsWith(".")) {
        const target = resolve(dirname(file), path);
        return target.startsWith(`${GOOGLE}/`) ? [] : [`${relative(GOG, file)} -> ${path}`];
      }
      const name = path.startsWith("node:") ? path.slice(5) : path;
      return BUILTINS.has(name) || path === "zod" ? [] : [`${relative(GOG, file)} -> ${path}`];
    }));
    expect(outside).toEqual([]);
  });

  test("the operations module never imports the transport", () => {
    const into = tsFiles(GOOGLE).flatMap(file => importsOf(file).filter(path => path.includes("gog")).map(path => `${relative(GOOGLE, file)} -> ${path}`));
    expect(into).toEqual([]);
  });

  test("the export map serves its source to bun and its build to everything else", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
    expect(manifest.exports["./internal/google-gog"]).toEqual({
      bun: "./src/google/gog/index.ts",
      types: "./dist/google/gog/index.d.ts",
      default: "./dist/google/gog/index.js",
    });
  });

  test("the entry point exposes the transport factory, never the pin's test parameters or the raw runner", () => {
    expect(typeof entry.createGogTransport).toBe("function");
    expect(typeof entry.verifyGogBinary).toBe("function");
    for (const internal of ["createGogTransportInternals", "verifyGogBinaryWith", "runGogProcess", "gogArgv", "gogInvocation", "gogConcurrencyState"]) {
      expect(Object.keys(entry)).not.toContain(internal);
    }
  });
});
