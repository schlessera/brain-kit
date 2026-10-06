import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// Trackers end to end (#948, D52 §4), on the real public ChatPage in real
// Chrome against the real app and its recovery route: leave a running
// session by New chat, let it finish unwatched, reload, open it again. The
// tracker must survive the reload, take its times from the host, and clear
// only once the latest turn is actually on screen: not while a panel covers
// Chat, not while the transcript is scrolled up. Keyless: the backend is
// scripted, and each turn waits until the test lets it finish.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Tracker runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING tracker runtime proof: no Chrome; trackers are unverified in a browser locally.");

const repo = resolve(import.meta.dir, "../../..");
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let origin = "";
let sequence = 0;
const transcripts = new Map<string, SessionHistoryMessage[]>();
const gates = new Map<string, () => void>();
const turnsStarted: string[] = [];

/** A long answer, so the transcript scrolls at every width. */
const LOG = Array.from({ length: 60 }, (_, i) => `Day ${i + 1}: the wax held, and the crew rowed on.`).join("\n\n");

beforeAll(async () => {
  if (!executablePath) return;
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Tracker fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-trackers-"));
  const brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/tracker-runtime-client.ts"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Tracker client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  const backend: AgentBackend = {
    id: "trackers-scripted", capabilities: { resume: true, permissions: false, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "trackers-scripted", label: "Local fixture" }],
    listSessions: async () => [...transcripts.keys()].map((id) => ({ id, title: "The voyage home", createdAt: 1, lastActiveAt: 2, totalCostUsd: 0, numTurns: 1 })),
    getHistory: async (sessionId) => structuredClone(transcripts.get(sessionId) ?? []),
    async startTurn({ prompt, bridge, sessionId: resumed }) {
      const sessionId = resumed ?? `odysseus-voyage-${++sequence}`;
      turnsStarted.push(sessionId);
      bridge.emit({ type: "session_info", sessionId, isNew: !resumed });
      const transcript = transcripts.get(sessionId) ?? [];
      transcripts.set(sessionId, transcript);
      transcript.push({ role: "user", content: prompt, toolCalls: [] });
      bridge.emit({ type: "text_delta", sessionId, text: "Setting out. " });
      await new Promise<void>((release) => gates.set(prompt, release));
      transcript.push({ role: "assistant", content: `Setting out. ${LOG}`, toolCalls: [] });
      bridge.emit({ type: "text_delta", sessionId, text: LOG });
      bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }), staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), turnTimeoutMs: 60_000 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 180_000);

afterAll(async () => {
  for (const release of gates.values()) release();
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

type Fixture = {
  connected(): boolean;
  activeSessionId(): string | null;
  views(): Array<{ sessionId: string; state: string; cleared: boolean; startedAt: number | null; endedAt: number | null; turnId: string | null }>;
  records(): Record<string, { seen: { turnId: string; basis: string } | null }>;
  lastTurnId(): string | null;
  setSessionPanel(open: boolean): void;
  resume(sessionId: string): void;
};
const fixture = <T,>(page: Page, fn: (f: Fixture) => T) =>
  page.evaluate(`(${fn.toString()})(window.__trackers)`) as Promise<T>;

async function until(page: Page, predicate: string, timeout = 15_000) {
  await page.waitForFunction(`(() => { const f = window.__trackers; return ${predicate}; })()`, undefined, { timeout });
}

async function release(prompt: string) {
  for (let i = 0; i < 200 && !gates.has(prompt); i++) await Bun.sleep(25);
  const gate = gates.get(prompt);
  if (!gate) throw new Error(`No turn is waiting on ${prompt}`);
  gates.delete(prompt);
  gate();
}

const runs: Array<{ name: string; theme: "dark" | "light"; options: BrowserContextOptions }> = [
  { name: "320 phone, dark, coarse pointer", theme: "dark", options: { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true } },
  { name: "320 phone, light, coarse pointer", theme: "light", options: { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true } },
  { name: "390 phone, light, coarse pointer", theme: "light", options: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  { name: "480 tablet, dark, coarse pointer", theme: "dark", options: { viewport: { width: 480, height: 800 }, hasTouch: true } },
  { name: "900 short viewport, light, reduced motion", theme: "light", options: { viewport: { width: 900, height: 480 }, reducedMotion: "reduce" } },
  { name: "1280 desktop, dark", theme: "dark", options: { viewport: { width: 1280, height: 800 } } },
  { name: "1440 desktop, light, reduced motion", theme: "light", options: { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" } },
];

describe.skipIf(!executablePath)("mounted trackers", () => {
  for (const run of runs) {
    test(`${run.name}: left running, finished unwatched, reloaded, cleared only once seen`, async () => {
      const context = await browser!.newContext(run.options);
      await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript((theme) => {
        document.documentElement.dataset.theme = theme;
        if (theme === "dark") document.documentElement.classList.add("dark");
      }, run.theme);
      const page = await context.newPage();
      const prompt = `Sail past the Sirens (${run.name})`;
      try {
        await page.goto(origin);
        await until(page, "f?.connected()");
        const composer = page.locator("textarea.bk-composer");
        await composer.fill(prompt);
        await composer.press("Enter");
        await until(page, "f.activeSessionId() !== null && f.lastTurnId() !== null");
        const sessionId = (await fixture(page, (f) => f.activeSessionId()))!;
        // Watching it: nothing is tracked.
        expect(await fixture(page, (f) => f.views().length)).toBe(0);

        // New chat while it runs: one tracker, running.
        await page.getByRole("button", { name: "New chat", exact: true }).click();
        await until(page, "f.views().length === 1");
        expect(await fixture(page, (f) => f.views().map((v) => [v.sessionId, v.state, v.cleared]))).toEqual([[sessionId, "running", false]]);
        expect(await fixture(page, (f) => f.activeSessionId())).toBeNull();

        // It finishes unwatched: done, with the host's own times.
        await release(prompt);
        await until(page, "f.views()[0]?.state === 'done' && f.views()[0]?.endedAt !== null");
        const done = (await fixture(page, (f) => f.views()[0]))!;
        expect(done.startedAt).not.toBeNull();
        expect(done.endedAt!).toBeGreaterThanOrEqual(done.startedAt!);

        // A reload keeps it, and the host confirms it again.
        await page.reload();
        await until(page, "f?.connected()");
        await until(page, "f.views()[0]?.state === 'done' && f.views()[0]?.endedAt !== null");
        expect(await fixture(page, (f) => f.views().map((v) => [v.sessionId, v.state, v.cleared]))).toEqual([[sessionId, "done", false]]);

        // Opened behind the session panel: selected, its answer replayed
        // with the host-proven turn, and still not seen.
        await fixture(page, (f) => f.setSessionPanel(true));
        await fixture(page, (f) => f.resume(f.views()[0]!.sessionId));
        await until(page, `f.lastTurnId() === f.views()[0]?.turnId`);
        await page.getByText("Day 60: the wax held, and the crew rowed on.").waitFor({ state: "attached" });
        expect(await fixture(page, (f) => f.views()[0]!.cleared)).toBe(false);

        // Scrolled up, with the panel closed: still not seen.
        await page.evaluate(() => {
          const column = document.querySelector("[data-reading-column]")!.parentElement!;
          column.scrollTop = 0;
          column.dispatchEvent(new Event("scroll"));
        });
        await fixture(page, (f) => f.setSessionPanel(false));
        const disc = page.getByRole("button", { name: "Scroll to latest", exact: true });
        await disc.waitFor();
        await page.waitForTimeout(150);
        expect(await fixture(page, (f) => f.views()[0]!.cleared)).toBe(false);

        // The latest turn on screen: seen, by proof.
        if (run.options.hasTouch) await disc.tap();
        else await disc.click();
        try { await until(page, "f.views()[0]?.cleared === true", 5000); }
        catch (error) {
          // What the observer saw, so a failure here says which condition held it.
          console.error("tracker state", JSON.stringify(await page.evaluate("window.__trackers.debug()")));
          throw error;
        }
        const seen = await fixture(page, (f) => Object.values(f.records())[0]!.seen);
        expect(seen).toMatchObject({ basis: "proof", turnId: done.turnId! });
        // Recovery reads and seen observation started no model turn.
        expect(turnsStarted.filter((id) => id === sessionId)).toHaveLength(1);
      } finally {
        await context.close();
        // A run that failed mid-way must not leave its turn running into the
        // next one, where the host would announce it as unwatched work.
        gates.get(prompt)?.();
        gates.delete(prompt);
      }
    }, 90_000);
  }
});
