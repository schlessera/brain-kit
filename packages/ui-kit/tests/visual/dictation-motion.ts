/// <reference types="@vitest/browser-playwright" />
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { BrowserCommand } from "vitest/node";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
let themeStyles: Promise<string> | undefined;

/** Compile the documented Tailwind consumer entry against the built theme export. */
export const dictationThemeStyles: BrowserCommand<[], string> = async () => {
  themeStyles ??= (async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "brain-dictation-theme-"));
    try {
      const output = resolve(temporary, "consumer.css");
      const manifest = require.resolve("@tailwindcss/cli/package.json");
      await exec(process.execPath, [resolve(dirname(manifest), "dist/index.mjs"),
        "-i", resolve("tests/visual/dictation-theme.css"), "-o", output, "--minify"]);
      return await readFile(output, "utf8");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  })();
  return themeStyles;
};

/** Chromium evaluates the real media query; no matchMedia stub. */
export const dictationMotion: BrowserCommand<["reduce" | "no-preference"]> = async (ctx, reducedMotion) => {
  await ctx.page.emulateMedia({ reducedMotion });
};

declare module "vitest/browser" {
  interface BrowserCommands {
    dictationThemeStyles(): Promise<string>;
    dictationMotion(reducedMotion: "reduce" | "no-preference"): Promise<void>;
  }
}
