import path from "node:path";
import { fileURLToPath } from "node:url";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Every story becomes a Vitest test — a render smoke test plus its play
// function — running in a real Chromium through Playwright, not happy-dom.
// This is a SEPARATE runner from the repo's `bun test`; the two coexist and
// are run as two commands.
//
// There is deliberately no `.storybook/vitest.setup.ts`: since Storybook 10.3
// the addon applies `setProjectAnnotations` itself, and adding the file back
// makes it skip that and warn. The published docs snippets are stale on this.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          plugins: [
            storybookTest({
              configDir: path.join(dirname, ".storybook"),
              storybookScript: "bun run storybook --no-open",
              storybookUrl: process.env.SB_URL,
            }),
          ],
          test: {
            name: "storybook",
            browser: {
              enabled: true,
              provider: playwright({}),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
      ],
    },
  })
);
