import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.js";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(path => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath) throw new Error("Turn journal proof requires real Chrome");
const repo = resolve(import.meta.dir, "../../.."), password = "the bow only Odysseus can string", turnId = "odysseus-journal";
let root = "", origin = "", browser: Browser, app: Awaited<ReturnType<typeof createApp>>, server: ReturnType<typeof Bun.serve>;
async function child(args: string[]) {
  const process = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`Journal fixture build failed (${code})\n${out}${err}`);
}
beforeAll(async () => {
  if (process.env.BRAIN_JOURNAL_DEPENDENCIES_BUILT !== "1") await child([process.execPath, "scripts/build.ts"]);
  root = await mkdtemp(resolve(tmpdir(), "odysseus-journal-browser-"));
  const brain = resolve(root, "brain"), assets = resolve(root, "assets");
  await createFixtureBrain(repo, brain); await mkdir(assets);
  await writeFile(resolve(brain, "notes/voyage.md"), "Ithaca\r\n");
  await child([process.execPath, "-e", 'const result=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!result.success){console.error(result.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/turn-journal-client.tsx"), assets]);
  const backend = makeFakeBackend({ id: "journal-fixture" });
  app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), AUTH_MODE: "password", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(password), COOKIE_SECRET: "odysseus-journal-cookie-secret-0123456789", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), staticRoot: assets, observability: createRecordingObservability() });
  app.wsHost.journal!.begin(turnId, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  await writeFile(resolve(brain, "notes/voyage.md"), "Athena charts the return.\r\n");
  app.wsHost.journal!.finish(turnId);
  const seed = JSON.stringify({ turnId, summary: app.wsHost.journal!.summary(turnId) });
  await writeFile(resolve(assets, "index.html"), `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odysseus journal</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;background:var(--bk-color-canvas);color:var(--bk-color-ink)}main{padding:16px;max-width:900px}textarea{max-width:100%}</style></head><body><div id="app"></div><script>window.__journalSeed=${seed}</script><script type="module" src="/client.js"></script></body></html>`);
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket }); origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 180_000);
afterAll(async () => { await browser?.close(); server?.stop(true); await app?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function scene(width = 1280, theme = "dark", replay = false) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" }), outside: string[] = [];
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (outside.push(route.request().url()), route.abort()));
  expect((await context.request.post(`${origin}/api/auth/login`, { data: { password } })).status()).toBe(200);
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/?${new URLSearchParams({ theme, ...(replay ? { replay: "1" } : {}) })}`);
  try { await page.getByRole("button", { name: /changed file/ }).waitFor({ timeout: 5000 }); }
  catch { const body = await page.locator("body").innerText(); await context.close(); throw new Error(`Journal scene failed: ${body}; ${errors.join("; ")}`); }
  return { context, page, outside };
}
for (const width of [320, 1280]) for (const theme of ["dark", "light"]) for (const replay of [false, true]) test(`journal ${replay ? "replay" : "live"} ${theme} ${width} starts collapsed and reviews raw versions with stable keyboard focus`, async () => {
  const { context, page, outside } = await scene(width, theme, replay);
  try {
    const disclosure = page.getByRole("button", { name: /changed file/ });
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect((await disclosure.boundingBox())!.height, "JOURNAL_DISCLOSURE_44PX").toBeGreaterThanOrEqual(44);
    await page.getByRole("textbox", { name: "Message" }).focus();
    await page.evaluate(id => (window as any).__journalFixture.frame({ type: "turn_journal", sessionId: "ithaca", turnId: id, journal: (window as any).__journalSeed.summary }), turnId);
    expect(await page.getByRole("textbox", { name: "Message" }).evaluate(element => document.activeElement === element), "JOURNAL_ARRIVAL_NEVER_STEALS_FOCUS").toBe(true);
    expect(await page.evaluate(() => (window as any).__journalFixture.state().streaming), "JOURNAL_RECEIPT_NEVER_REOPENS_TURN").toBe(false);
    expect(await page.evaluate(() => (window as any).__journalFixture.state().runState), "JOURNAL_RECEIPT_NEVER_REOPENS_RUN_STATE").toBe("idle");
    await disclosure.focus(); await page.keyboard.press("Enter");
    const review = page.getByRole("button", { name: "Review notes/voyage.md", exact: true }); await review.waitFor();
    await review.focus(); await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Retained change", exact: true }).waitFor();
    await page.getByText("Athena charts the return.", { exact: true }).waitFor();
    expect(await page.getByRole("heading", { name: "notes/voyage.md", exact: true }).evaluate(element => document.activeElement === element), "JOURNAL_READER_HEADING_FOCUS").toBe(true);
    expect(await page.getByRole("button", { name: /Revert/ }).count()).toBe(0);
    const download = page.getByRole("link", { name: /Download before/ });
    expect(await download.evaluate(async element => { const response = await fetch((element as HTMLAnchorElement).href); return { status: response.status, text: await response.text() }; })).toEqual({ status: 200, text: "Ithaca\r\n" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "JOURNAL_RESPONSIVE_BOUNDS").toBe(true);
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "JOURNAL_ZOOM_BOUNDS").toBe(true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Review notes/voyage.md");
    expect(await disclosure.getAttribute("aria-expanded"), "JOURNAL_ESCAPE_ONLY_CLOSES_READER").toBe("true");
    expect(outside).toEqual([]);
  } finally { await context.close(); }
});
test("journal stale-session responses and expired receipts expose no retained reader actions", async () => {
  const { context, page } = await scene();
  try {
    const disclosure = page.getByRole("button", { name: /changed file/ }); await disclosure.click();
    await page.getByRole("button", { name: "Review notes/voyage.md", exact: true }).waitFor();
    await page.evaluate(id => (window as any).__journalFixture.frame({ type: "turn_journal", sessionId: "ithaca", turnId: id, journal: { ...(window as any).__journalSeed.summary, state: "expired" } }), turnId);
    await page.getByText("Retained details expired. Raw versions and review actions are unavailable.", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: /Review notes/ }).count()).toBe(0);
    await page.evaluate(() => (window as any).__journalFixture.switchSession());
    expect(await page.getByRole("dialog").count()).toBe(0);
  } finally { await context.close(); }
});
