/**
 * The reverse of `undeclared-tokens.test.ts` (#4699): every token the kit
 * declares in `TOKENS` is read by something. A palette row is three
 * declarations and a contrast review, and a token whose last reader is
 * deleted otherwise stays forever, because nothing reports it.
 *
 * Read means the name appears, outside the declarations themselves, as
 * `--bk-<name>` or as a quoted token name (`token("<name>")`), in the kit's
 * source, stories and Storybook config, in ui-react, in the website and in
 * the module packages, which ship content renderers.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

import { TOKENS } from "../src/tokens.js";
import { PACKAGE_ROOT } from "./_theme.js";

const REPO = resolve(PACKAGE_ROOT, "..", "..");
const modules = readdirSync(join(REPO, "packages")).filter((p) => p.startsWith("module-")).map((p) => join(REPO, "packages", p, "src"));
const ROOTS = [
  ...["src", "stories", ".storybook"].map((dir) => join(PACKAGE_ROOT, dir)),
  join(REPO, "packages", "ui-react", "src"),
  join(REPO, "website", "src"),
  ...modules,
].filter(existsSync);

/**
 * Names no plain search finds, because a template string builds them. Each
 * entry names the line that builds it; the list was derived by running this
 * test's scan without it and reading every name it reported. (The
 * `canvas-slot-*` names are built the same way, but the diagrams module's
 * generated skin names each one, so they need no entry.)
 */
const TEMPLATE_BUILT: Record<string, string> = {
  ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`canvas-ramp-${n}`, "src/tokens.ts: canvas.ramp, token(`canvas-ramp-${n}`)"])),
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : files(path);
    return /\.(css|tsx?|astro|mdx?)$/.test(entry) ? [path] : [];
  });
}

/** The declarations are not readers: drop the three palettes and every `--bk-x:`. */
function code(path: string): string {
  let text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  if (!path.endsWith(".css")) text = text.replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  if (path === join(PACKAGE_ROOT, "src", "tokens.ts")) {
    text = text.replace(/export const (TOKENS|LIGHT_TOKENS|PRINT_TOKENS)\b[^{]*\{[^}]*\}/g, "");
  }
  return text.replace(/--bk-[\w-]+\s*:/g, "");
}

const corpus = ROOTS.flatMap(files).map((path) => ({ name: relative(REPO, path), text: code(path) }));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const readers = (name: string) => {
  const pattern = new RegExp(`--bk-${escape(name)}(?![\\w-])|["'\`]${escape(name)}["'\`]`);
  return corpus.filter(({ text }) => pattern.test(text)).map(({ name: file }) => file);
};

describe("tokens the kit declares", () => {
  test("the scan reached every root", () => {
    // A guard on the guard: an empty scan would report everything, and a
    // missing root would hide its readers.
    expect(ROOTS.length).toBeGreaterThanOrEqual(5);
    expect(corpus.length).toBeGreaterThan(500);
  });

  test("every token in TOKENS has a reader", () => {
    const unread = Object.keys(TOKENS).filter((name) => !(name in TEMPLATE_BUILT) && readers(name).length === 0);
    expect(unread).toEqual([]);
  });

  test("the template-built list holds only names a plain search cannot find", () => {
    for (const name of Object.keys(TEMPLATE_BUILT)) {
      expect(name in TOKENS, `${name} is a token`).toBe(true);
      expect(readers(name), `${name} is found by a plain search, so it does not belong in the list`).toEqual([]);
    }
  });
});
