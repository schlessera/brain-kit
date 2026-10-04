import path from "node:path";
import { fileURLToPath } from "node:url";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import { requestLog, startRequestLog } from "./tests/visual/request-log.ts";
import { formViewport, formConsumerStyles } from "./tests/visual/form-browser.ts";
import { dictationThemeStyles, dictationMotion } from "./tests/visual/dictation-motion.ts";
import { moduleSettingsScreenshot } from "./tests/visual/module-settings-browser.ts";
import { dictationPointer } from "./tests/visual/dictation-pointer.ts";
import { buttonPointer, buttonCapture } from "./tests/visual/button-browser.ts";
import { rankTouch } from "./tests/visual/rank-pointer.ts";
import { rankFooterFonts, rankFooterDrag, rankFooterCapture } from "./tests/visual/rank-footer-browser.ts";
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
//
// Two story projects, one per theme — D9's matrix. `initialGlobals` pins the
// addon-themes `theme` global for every story the project runs, so the light
// project renders all 540-odd stories on paper with the same play functions
// and the same a11y gate at `'error'`. That is the light theme's contrast
// proof: axe on every rendered story, not a table of numbers.
const storyProject = (name: string, theme: string) => ({
  extends: true,
  plugins: [
    storybookTest({
      configDir: path.join(dirname, ".storybook"),
      storybookScript: "bun run storybook --no-open",
      storybookUrl: process.env.SB_URL,
      initialGlobals: { theme },
    }),
  ],
  test: {
    name,
    browser: {
      enabled: true,
      provider: playwright({}),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});

// Chromium's pointer settings are bit fields: coarse=2, fine=4. Keep each
// input scene in its own browser; the tests assert the actual media queries
// before measuring CSS or dispatching native touch input (no matchMedia mock).
const railProject = (mode: "fine" | "coarse" | "mixed") => ({
  extends: true,
  test: {
    name: `rail-${mode}`,
    include: ["tests/visual/side-rail-targets.visual.tsx"],
    provide: { railPointer: mode },
    browser: {
      enabled: true,
      commands: { rankTouch, formViewport },
      provider: playwright({
        launchOptions: { args: [`--blink-settings=availablePointerTypes=${mode === "mixed" ? 6 : mode === "coarse" ? 2 : 4},primaryPointerType=${mode === "coarse" ? 2 : 4}`] },
        contextOptions: { reducedMotion: "reduce" },
      }),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: "ui-react-layout",
            // Measurements of the real consumer, kept out of Bun's test glob.
            include: ["../ui-react/tests/browser/**/*.layout.tsx"],
            browser: {
              enabled: true,
              screenshotFailures: false,
              commands: { formViewport, formConsumerStyles, rankFooterFonts },
              provider: playwright({ contextOptions: { reducedMotion: "reduce" } }),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
        storyProject("storybook", "dark"),
        storyProject("storybook-light", "light"),
        railProject("fine"),
        railProject("coarse"),
        railProject("mixed"),
        {
          extends: true,
          test: {
            name: "visual",
            // `.visual.tsx`, deliberately NOT `.test.tsx`: the repo's `bun run test`
            // globs `packages/**` for `*.test.ts(x)` and would claim these, then
            // fail on the first story import because bun's runner has no Vite and
            // cannot resolve `#.storybook/preview`. Two runners, two extensions.
            include: ["tests/visual/**/*.visual.tsx"],
            exclude: ["tests/visual/rank-footer-touch.visual.tsx", "tests/visual/module-settings.visual.tsx", "tests/visual/subjects.visual.tsx", "tests/visual/dictation-panel.visual.tsx", "tests/visual/side-rail-targets.visual.tsx"],
            browser: {
              enabled: true,
              // The link card's no-request proof reads the network from
              // Playwright (`tests/visual/request-log.ts`).
              commands: { startRequestLog, requestLog, rankTouch, rankFooterFonts, rankFooterDrag, rankFooterCapture, formViewport, formConsumerStyles, buttonPointer, buttonCapture },
              provider: playwright({}),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
        {
          extends: true,
          test: {
            // Chromium's touch-emulation disable does not restore a fine
            // pointer. Keep this complete consumer fixture in its own provider
            // lifetime, even when files in another project reuse their page.
            name: "dictation",
            include: ["tests/visual/dictation-panel.visual.tsx"],
            browser: {
              enabled: true,
              commands: { formViewport, formConsumerStyles, dictationPointer, dictationThemeStyles, dictationMotion, rankTouch },
              provider: playwright({}),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
        {
          extends: true,
          test: {
            // A failure screenshot in another file changes Chromium's used
            // monospace fallback even after that file restores its DOM/viewport.
            // Keep incumbent subject pixels in a separate browser process (#879).
            name: "subjects",
            include: ["tests/visual/subjects.visual.tsx"],
            browser: {
              enabled: true,
              commands: { formViewport },
              provider: playwright({}),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
        {
          extends: true,
          test: {
            // Consumer styles, viewport changes and font fallback must not
            // share the kit baseline project's browser process.
            name: "module-settings",
            include: ["tests/visual/module-settings.visual.tsx"],
            browser: {
              enabled: true,
              commands: { formViewport, formConsumerStyles, moduleSettingsScreenshot },
              provider: playwright({}),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
        {
          extends: true,
          test: {
            name: "rank-footer-touch",
            include: ["tests/visual/rank-footer-touch.visual.tsx"],
            browser: {
              enabled: true,
              commands: { rankTouch, rankFooterFonts, rankFooterDrag, rankFooterCapture },
              provider: playwright({ contextOptions: { hasTouch: true } }),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
      ],
    },
  })
);
