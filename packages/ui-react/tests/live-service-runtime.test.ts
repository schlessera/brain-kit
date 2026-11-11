import { runtimePackageBuild } from "./fixtures/runtime-package-build";
// #3616: choosing the default live-conversation service in Settings › Voice,
// and which service the next explicit Start opens, in real Chrome against a
// real password-mode server. Two keyless live-service doubles stand in for
// Gemini Live and GPT-Live, registered through `createApp({
// conversationProviders })`; the server records every `open`, so it, not the
// page, says where a Start went. The app restarts over the same database to
// prove persistence and to remove a service. Every state is checked at 320px
// and 1280px. Nothing leaves loopback.
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { LiveConversationProvider } from "@schlessera/brain-ui-sdk/server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import { createPrincipal } from "../../ui-server/src/db/principals.js";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.ts";
import { fakeLiveProvider, type FakeLiveSession } from "../../ui-server/tests/helpers/live-conversation.ts";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Live service runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING live service runtime proof: no Chrome; Settings › Voice and Start binding are unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
const SECRET = "live-service-runtime-secret-0123456789";
const WIDTHS = [320, 1280] as const;
const SHOTS = process.env.BRAIN_LIVE_SERVICE_SCREENSHOTS;
const hook = runtimeHookPhases("live-service-runtime");

type Id = "gemini-live" | "gpt-live";
/** Every session each double opened, across restarts. */
const opened: Record<Id, FakeLiveSession[]> = { "gemini-live": [], "gpt-live": [] };
function double(id: Id): LiveConversationProvider {
  const fake = fakeLiveProvider();
  const voiceService = id === "gemini-live" ? "Fictional Gemini Live of Ithaca" : "Fictional GPT-Live of Ithaca";
  return { ...fake.provider, id, disclosure: { ...fake.provider.disclosure, voiceService },
    open: async (scope, options) => { const session = await fake.provider.open(scope, options); opened[id].push(fake.sessions.at(-1)!); return session; } };
}
const counts = () => ({ gemini: opened["gemini-live"].length, gpt: opened["gpt-live"].length });

let fixture = "", brain = "", assets = "", origin = "", port = 0;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
const cookies = { owner: "", reader: "" };
/** Every `/api/settings/voice` request, in order. */
const log: Array<{ method: string; status: number }> = [];

async function start(ids: Id[], hostDefault?: Id) {
  app = await hook.phase("host-start", () => createApp({
    config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(fixture, "ui.db"),
      AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1",
      HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([makeFakeBackend({ id: "live-fixture" })], "live-fixture"),
    staticRoot: assets, observability: createRecordingObservability(),
    conversationProviders: ids.map(double),
    ...(hostDefault ? { defaultConversationProviderId: hostDefault } : {}),
  }));
  const current = app;
  const handle = async (request: Request, bun: unknown) => {
    const response = await current.fetch(request, bun as never);
    const url = new URL(request.url);
    if (url.pathname === "/api/settings/voice") log.push({ method: request.method, status: response?.status ?? 0 });
    return response;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle, websocket: current.websocket });
      break;
    } catch (error) { if (attempt > 20) throw error; await Bun.sleep(50); }
  }
  port = server.port!;
  origin = `http://127.0.0.1:${port}`;
}
async function restart(ids: Id[], hostDefault?: Id) {
  await closeAll();
  server?.stop(true);
  await app?.close();
  await start(ids, hostDefault);
}

beforeAll(async () => {
  if (!executablePath) return;
  await runtimePackageBuild(repo, ["ui-react", "ui-server", "core"], hook);
  fixture = await mkdtemp(resolve(tmpdir(), "odysseus-live-service-"));
  brain = resolve(fixture, "brain");
  await mkdir(resolve(brain, "notes"), { recursive: true });
  await writeFile(resolve(brain, "notes", "ithaca.md"), "# Ithaca\n\nOdysseus is expected home on 2026-07-12.\n");
  assets = resolve(fixture, "assets");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const r=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!r.success){console.error(r.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/live-service-client.tsx"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await hook.child("client-build", bundle);
  if (code !== 0) throw new Error(`Live service client build failed (${code}): ${out}\n${err}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Odysseus live service</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}body{background:var(--bk-color-canvas);color:var(--bk-color-ink)}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  await start(["gemini-live", "gpt-live"]);
  const owner = createPrincipal(app!.db, { authMethod: "password", label: "Penelope's phone", ttlSeconds: 3600 });
  const reader = createPrincipal(app!.db, { authMethod: "delegated", createdBy: owner.id, label: "Telemachus agent", ttlSeconds: 3600 });
  for (const [who, principal] of [["owner", owner], ["reader", reader]] as const) {
    const signed = await generateSignedCookie("brain_ui_session", principal.id, SECRET);
    cookies[who] = signed.split(";")[0]!.slice("brain_ui_session=".length);
  }
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }));
}, 240_000);

afterAll(() => hook.phase("cleanup", async () => {
  await closeAll();
  await browser?.close();
  server?.stop(true);
  await app?.close();
  if (fixture) await rm(fixture, { recursive: true, force: true });
}));

/** The saved default as the owner's other device sets it, through the real route. */
async function otherDevice(defaultProvider: string | null) {
  const headers = { cookie: `brain_ui_session=${cookies.owner}`, origin, "content-type": "application/json" };
  const current = await (await fetch(`${origin}/api/settings/voice`, { headers })).json() as { defaultProvider: string | null; revision: number };
  if (current.defaultProvider === defaultProvider) return current;
  const response = await fetch(`${origin}/api/settings/voice`, { method: "PUT", headers, body: JSON.stringify({ defaultProvider, revision: current.revision }) });
  expect(response.status, "the other device saved").toBe(200);
  return await response.json() as { defaultProvider: string | null; revision: number };
}
const saved = async () => (await (await fetch(`${origin}/api/settings/voice`, { headers: { cookie: `brain_ui_session=${cookies.owner}` } })).json() as { defaultProvider: string | null }).defaultProvider;

const contexts: BrowserContext[] = [];
async function open(width: number, who: "owner" | "reader" = "owner"): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width, height: width < 900 ? 720 : 860 }, hasTouch: width < 900 });
  contexts.push(context);
  await context.addCookies([{ name: "brain_ui_session", value: cookies[who], url: `http://127.0.0.1:${port}` }]);
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  // Count every microphone request the page makes, from its first script on.
  await context.addInitScript(() => {
    const scope = window as unknown as { __gum: number };
    scope.__gum = 0;
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => { scope.__gum++; return original(constraints); };
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction("window.__live?.connected()");
  return page;
}
async function closeAll() { for (const context of contexts.splice(0)) await context.close(); }

type LiveState = { active: boolean; available: boolean; disclosureOpen: boolean; disclosed: string | null; opened: string | null; source: string | null; choice: string | null; services: string[];
  liveDefault: { saved: string | null; savedUsable: boolean; effective: string | null; source: string } | null };
const live = (page: Page) => page.evaluate(() => (window as unknown as { __live: { state(): LiveState } }).__live.state());
const gum = (page: Page) => page.evaluate(() => (window as unknown as { __gum: number }).__gum);
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}
/** No horizontal page scroll, and every row in the selector at least 44px tall. */
async function fits(page: Page, width: number, selector: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `no horizontal scroll at ${width}px`).toBeLessThanOrEqual(width);
  const heights = await page.locator(selector).evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  expect(heights.length, `${selector} rows at ${width}px`).toBeGreaterThan(0);
  for (const height of heights) expect(height, `${selector} target at ${width}px`).toBeGreaterThanOrEqual(44);
}
/** Opens Settings › Voice and waits until the Live service group has read the saved value. */
async function settings(page: Page) {
  const before = log.filter((entry) => entry.method === "GET").length;
  await page.evaluate(() => (window as unknown as { __live: { openSettings(): void } }).__live.openSettings());
  const group = page.locator("[data-live-service-settings]");
  await group.waitFor();
  for (let waited = 0; log.filter((entry) => entry.method === "GET").length <= before; waited += 10) { if (waited > 10_000) throw new Error("Settings never read the live default"); await Bun.sleep(10); }
  await page.waitForFunction(() => !document.querySelector("[data-live-service-settings]")?.getAttribute("aria-busy"));
  return group;
}
async function closeSettings(page: Page) {
  await page.evaluate(() => (window as unknown as { __live: { closeSettings(): void } }).__live.closeSettings());
}
/** Pick a radio and wait until the server answered the save and the pane shows no pending save. */
async function pick(page: Page, name: RegExp) {
  const before = log.filter((entry) => entry.method === "PUT").length;
  await page.locator("[data-live-service-settings]").getByRole("radio", { name }).check();
  for (let waited = 0; log.filter((entry) => entry.method === "PUT").length <= before; waited += 10) { if (waited > 10_000) throw new Error("No live settings save reached the server"); await Bun.sleep(10); }
  await page.waitForFunction(() => !document.querySelector("[data-live-service-settings] [role=status]")?.textContent?.includes("Saving"));
}
/** Enter live conversation: the disclosure sheet, before any Start. */
async function enter(page: Page) {
  await page.waitForFunction("window.__live.ready()");
  await page.evaluate(() => (window as unknown as { __live: { enter(): void } }).__live.enter());
  await page.waitForFunction(() => (window as unknown as { __live: { state(): LiveState } }).__live.state().disclosureOpen);
  return page.locator('[data-overlay-site="conversation-disclosure"]');
}
async function startAndWait(page: Page) {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { __live: { state(): LiveState } }).__live.state().opened !== null);
}
async function leave(page: Page) {
  await page.evaluate(() => (window as unknown as { __live: { leave(): void } }).__live.leave());
  await page.waitForFunction(() => !(window as unknown as { __live: { state(): LiveState } }).__live.state().active);
}

describe.skipIf(!executablePath)("Settings › Voice live service and the next Start, against mounted routes", () => {
  for (const width of WIDTHS) test(`${width}px: pick, reload, restart; Settings opens no microphone or provider`, async () => {
    await restart(["gemini-live", "gpt-live"]);
    await otherDevice(null);
    const before = counts();
    let page = await open(width);
    const group = await settings(page);
    // Several services, nothing saved, no host default: nothing checked.
    expect(await group.locator("[data-live-service-pick]").textContent()).toBe("Pick a default");
    expect(await group.getByRole("radio", { checked: true }).count(), "nothing is checked").toBe(0);
    expect(await group.getByRole("radiogroup", { name: "Live service" }).count()).toBe(1);
    await fits(page, width, "[data-live-service-option]");
    await shot(page, `live-pick-${width}`);
    if (width >= 900) {
      // Desktop: exactly two services side by side, the label in its column.
      const [a, b] = await group.locator("[data-live-service-option]").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().top));
      expect(Math.round(a!), "two services side by side").toBe(Math.round(b!));
    }

    await pick(page, /GPT-Live/);
    expect(await saved(), "the pick was saved brain-wide").toBe("gpt-live");
    expect(await group.getByText("saved default").count()).toBe(1);
    // Keyboard: the arrow moves the choice and saves it.
    await group.getByRole("radio", { name: /GPT-Live/ }).focus();
    const puts = log.filter((entry) => entry.method === "PUT").length;
    await page.keyboard.press(width >= 900 ? "ArrowLeft" : "ArrowUp");
    for (let waited = 0; log.filter((entry) => entry.method === "PUT").length <= puts; waited += 10) { if (waited > 10_000) throw new Error("Arrow key did not save"); await Bun.sleep(10); }
    await page.waitForFunction(() => !document.querySelector("[data-live-service-settings] [role=status]")?.textContent?.includes("Saving"));
    expect(await saved()).toBe("gemini-live");
    await pick(page, /GPT-Live/);

    // Reload: the saved default is still checked.
    await page.reload();
    await page.waitForFunction("window.__live?.connected()");
    let again = await settings(page);
    expect(await again.getByRole("radio", { name: /GPT-Live/ }).isChecked(), "LIVE_DEFAULT_RELOAD_PERSISTS").toBe(true);
    // Restart over the same database: still saved.
    await restart(["gemini-live", "gpt-live"]);
    page = await open(width);
    again = await settings(page);
    expect(await again.getByRole("radio", { name: /GPT-Live/ }).isChecked(), "LIVE_DEFAULT_RESTART_PERSISTS").toBe(true);
    expect(await gum(page), "SETTINGS_OPENS_NO_MICROPHONE").toBe(0);
    expect(counts(), "SETTINGS_OPENS_NO_PROVIDER").toEqual(before);
    await closeSettings(page);
  }, 120_000);

  for (const width of WIDTHS) test(`${width}px: the next Start opens the saved default; Change applies once and is not saved`, async () => {
    await restart(["gemini-live", "gpt-live"]);
    await otherDevice("gpt-live");
    const page = await open(width);
    const before = counts();
    let sheet = await enter(page);
    // The disclosure names the saved default before any Start.
    expect(await sheet.getByText("Fictional GPT-Live of Ithaca").count()).toBe(1);
    expect(counts(), "NO_PROVIDER_BEFORE_START").toEqual(before);
    expect(await gum(page), "NO_MICROPHONE_BEFORE_START").toBe(0);
    await fits(page, width, "[data-live-service-pick] label");
    await shot(page, `live-sheet-${width}`);
    await startAndWait(page);
    expect(counts(), "SAVED_DEFAULT_OPENS").toEqual({ gemini: before.gemini, gpt: before.gpt + 1 });
    expect((await live(page)).source).toBe("saved");

    // A save from another device does not retarget the running conversation.
    await otherDevice("gemini-live");
    await page.waitForFunction(() => (window as unknown as { __live: { state(): LiveState } }).__live.state().liveDefault?.saved === "gemini-live");
    const running = await live(page);
    expect(running.opened, "RUNNING_KEEPS_SERVICE").toBe("gpt-live");
    expect(running.disclosed).toBe("gpt-live");
    expect(opened["gpt-live"].at(-1)!.closed).toBe(false);
    expect(counts()).toEqual({ gemini: before.gemini, gpt: before.gpt + 1 });
    await leave(page);

    // The next Start uses the new default; Change picks GPT-Live for this one only.
    sheet = await enter(page);
    expect(await sheet.getByText("Fictional Gemini Live of Ithaca").count()).toBe(1);
    await sheet.getByRole("radio", { name: "GPT-Live" }).check();
    expect(await sheet.getByText("Fictional GPT-Live of Ithaca").count(), "the disclosure follows the pick").toBe(1);
    expect(counts(), "a pick opens nothing").toEqual({ gemini: before.gemini, gpt: before.gpt + 1 });
    await startAndWait(page);
    expect(counts(), "CHANGE_OPENS_PICK").toEqual({ gemini: before.gemini, gpt: before.gpt + 2 });
    expect((await live(page)).source).toBe("change");
    expect(await saved(), "CHANGE_IS_NOT_SAVED").toBe("gemini-live");
    await leave(page);

    // The pick ended with that entry: the next Start is the saved default again.
    sheet = await enter(page);
    expect((await live(page)).disclosed).toBe("gemini-live");
    await startAndWait(page);
    expect(counts()).toEqual({ gemini: before.gemini + 1, gpt: before.gpt + 2 });
    await leave(page);
  }, 120_000);

  for (const width of WIDTHS) test(`${width}px: an unavailable saved default needs an explicit pick and is kept`, async () => {
    await restart(["gemini-live", "gpt-live"]);
    await otherDevice("gpt-live");
    await restart(["gemini-live"], "gemini-live");
    const page = await open(width);
    const group = await settings(page);
    const dashed = group.locator("[data-live-service-unavailable]");
    expect(await dashed.textContent()).toContain("saved default · not available");
    expect(await group.getByRole("radio", { name: /GPT-Live/ }).count(), "the unavailable default cannot be chosen").toBe(0);
    expect(await group.getByRole("radio", { name: /Gemini Live/ }).isChecked(), "the host default is not substituted").toBe(false);
    await fits(page, width, "[data-live-service-settings] .bk-live-service-row");
    await shot(page, `live-unavailable-${width}`);
    await closeSettings(page);

    const before = counts();
    const sheet = await enter(page);
    expect(await sheet.locator("[data-live-service-unavailable]").textContent()).toContain("GPT-Live");
    expect(await page.getByRole("button", { name: "Start", exact: true }).isDisabled(), "S3D_START_NEEDS_PICK").toBe(true);
    expect(counts(), "S3D_NO_SUBSTITUTE").toEqual(before);
    await shot(page, `live-s3d-${width}`);
    await sheet.getByRole("radio", { name: "Gemini Live" }).check();
    await startAndWait(page);
    expect(counts(), "S3D_PICK_OPENS").toEqual({ gemini: before.gemini + 1, gpt: before.gpt });
    expect(await saved(), "the unavailable saved default is kept").toBe("gpt-live");
    await leave(page);
  }, 120_000);

  for (const width of WIDTHS) test(`${width}px: a non-owner sees the default read-only and cannot write it`, async () => {
    await restart(["gemini-live", "gpt-live"], "gemini-live");
    await otherDevice(null);
    const page = await open(width, "reader");
    const group = page.locator("[data-live-service-settings]");
    await page.evaluate(() => (window as unknown as { __live: { openSettings(): void } }).__live.openSettings());
    await group.locator("[data-live-service-owner]").waitFor();
    expect(await group.getByRole("radio", { name: /Gemini Live/ }).isChecked(), "the host default is shown").toBe(true);
    for (const radio of await group.getByRole("radio").all()) expect(await radio.isDisabled()).toBe(true);
    const refused = await page.evaluate(async () => (await fetch("/api/settings/voice", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultProvider: "gpt-live", revision: 0 }) })).status);
    expect(refused, "LIVE_SETTINGS_OWNER_ONLY").toBe(403);
    expect(await saved()).toBe(null);
  }, 120_000);
});
