// Fixture projects for the browser repetition gate's own tests (#4163,
// scripts/browser-determinism.ts). Deliberately outside `packages/`: no
// browser, layout or story project of `packages/ui-kit/vitest.config.ts`
// includes these specs, so the ordinary suites never run a fixture that is
// meant to fail. Two projects list every spec, so one file expands to two
// project/file pairs as a story does for its two themes.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const project = name => ({
  extends: true,
  test: {
    name,
    include: ["*.repeat.js"],
    browser: { enabled: true, headless: true, screenshotFailures: false, provider: playwright({}), instances: [{ browser: "chromium" }] },
  },
});

export default defineConfig({
  // The checkout stays clean: Vite's dependency cache goes to the run's temporary directory.
  cacheDir: join(tmpdir(), "brain-kit-browser-determinism-fixture"),
  test: { projects: [project("harbour"), project("strait")] },
});
