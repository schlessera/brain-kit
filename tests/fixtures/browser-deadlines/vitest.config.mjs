// Isolated watchdog fixtures: no ordinary project includes these specs.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: join(tmpdir(), "brain-kit-browser-deadline-fixture"),
  test: {
    name: "harbour",
    include: ["*.repeat.js"],
    testTimeout: 1000,
    hookTimeout: 700,
    browser: { enabled: true, headless: true, screenshotFailures: false,
      provider: playwright({}), instances: [{ browser: "chromium" }] },
  },
});
