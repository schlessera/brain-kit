import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { installPausedLivenessClock } from "./fixtures/liveness-clock";

const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find(path => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Liveness clock regression requires real Chrome");
if (!executablePath) console.warn("SKIPPING liveness clock runtime regression: real Chrome unavailable.");
describe.skipIf(!executablePath)("liveness clock in a real browser", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] }); });
  afterAll(async () => { await browser?.close(); });

  for (const delayed of [false, true]) {
    test(`liveness clock setup survives ${delayed ? "delayed" : "ordinary"} pause delivery before application timers`, async () => {
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        await context.route("**/*", route => route.abort());
        const page = await context.newPage();
        const clock = page.clock;
        const descriptor = Object.getOwnPropertyDescriptor(clock, "pauseAt");
        const original = clock.pauseAt.bind(clock);
        let deliveries = 0;
        try {
          if (delayed) clock.pauseAt = async time => {
            deliveries++;
            // Fault injection between the caller's target selection and the
            // actual protocol command. performance advances even with fixed Date.
            const start = await page.evaluate(() => performance.now());
            await page.waitForFunction(start => performance.now() - start >= 150, start, { timeout: 5_000 });
            await original(time);
          };
          let error: unknown;
          try { await installPausedLivenessClock(page); } catch (caught) { error = caught; }
          expect(error, "LIVENESS_CLOCK_SETUP_SURVIVES_PROTOCOL_DELAY").toBeUndefined();
        } finally {
          if (descriptor) Object.defineProperty(clock, "pauseAt", descriptor);
          else Reflect.deleteProperty(clock, "pauseAt");
        }
        expect(deliveries).toBe(delayed ? 1 : 0);
        const epoch = new Date("2026-07-12T12:00:00Z").getTime();
        // The helper must be ready when it returns, before navigation's replay
        // can repair an incorrectly fixed Date on its own.
        await clock.runFor(1);
        expect(await page.evaluate(() => Date.now()), "LIVENESS_CLOCK_READY_BEFORE_NAVIGATION").toBe(epoch + 1);
        await clock.setSystemTime(epoch);
        // Navigation replays the real context clock log, just as the app does.
        await page.goto("data:text/html,<title>Ithaca</title>");
        expect(await page.evaluate(() => Date.now()), "LIVENESS_CLOCK_PINNED_DATE").toBe(epoch);
        await page.evaluate(() => {
          Object.assign(window, { __livenessTimer: false });
          setTimeout(() => Object.assign(window, { __livenessTimer: true }), 20);
        });
        // Negative observation only: a real protocol wait outlasts the page timer.
        // This is not a setup margin and does not advance the controlled clock.
        await page.waitForTimeout(40);
        expect(await page.evaluate(() => Date.now()), "LIVENESS_CLOCK_STAYS_PAUSED").toBe(epoch);
        await clock.runFor(19);
        expect(await page.evaluate(() => (window as unknown as { __livenessTimer: boolean }).__livenessTimer)).toBe(false);
        expect(await page.evaluate(() => Date.now()), "LIVENESS_CLOCK_DATE_ADVANCES_WITH_TIMERS").toBe(epoch + 19);
        await clock.runFor(1);
        expect(await page.evaluate(() => (window as unknown as { __livenessTimer: boolean }).__livenessTimer)).toBe(true);
        expect(await page.evaluate(() => Date.now())).toBe(epoch + 20);
      } finally { await context.close(); }
    });
  }

});
