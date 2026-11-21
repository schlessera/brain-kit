import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "..");
const MODULE = join(PACKAGE, "src/google");
const BUILTINS = new Set(builtinModules);
const transpiler = new Bun.Transpiler({ loader: "ts" });

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = sources(MODULE);

describe("@schlessera/brain-common/internal/google-operations is pure", () => {
  test("it has the files of the module", () => {
    expect(files.map(file => relative(MODULE, file)).sort()).toEqual(
      ["address.ts", "catalog.ts", "classify.ts", "encoding.ts", "ids.ts", "index.ts", "mime.ts", "projection.ts", "records.ts"]);
  });

  test("it imports nothing but its own files and zod: no Node built-in, no Bun module", () => {
    const outside = files.flatMap(file => transpiler.scanImports(readFileSync(file, "utf8")).flatMap(({ path }) => {
      if (path.startsWith(".")) {
        const target = resolve(dirname(file), path);
        return target.startsWith(`${MODULE}/`) ? [] : [`${relative(MODULE, file)} -> ${path}`];
      }
      const name = path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0]!;
      const runtime = path.startsWith("node:") || path.startsWith("bun:") || path === "bun" || BUILTINS.has(name);
      return name === "zod" && !runtime ? [] : [`${relative(MODULE, file)} -> ${path}`];
    }));
    expect(outside).toEqual([]);
  });

  test("its code names no runtime, process or network global", () => {
    const found = files.flatMap(file => {
      const code = transpiler.transformSync(readFileSync(file, "utf8"));
      return [...code.matchAll(/\b(?:Bun|Deno|process|require|fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b/g)]
        .map(match => `${relative(MODULE, file)}: ${match[0]}`);
    });
    expect(found).toEqual([]);
  });

  test("the export map serves its source to bun and its build to everything else", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
    expect(manifest.exports["./internal/google-operations"]).toEqual({
      bun: "./src/google/index.ts",
      types: "./dist/google/index.d.ts",
      default: "./dist/google/index.js",
    });
  });
});
