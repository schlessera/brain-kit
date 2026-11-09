import { runtimePackageBuild } from "./fixtures/runtime-package-build";
// #3709: choosing the dictation service in Settings › Voice, and binding the
// next take to it, in real Chrome against a real password-mode server. Two
// keyless provider doubles, alpha (saved audio) and beta (streaming, SMART),
// are registered through `createApp({ speechProviders })`; their example
// adapter opens a real socket to a local speech server, so the server says
// which service a take reached. The app restarts over the same database to
// remove a provider, then to have none, then one. Every state is checked at
// 320px and 1280px. Nothing leaves loopback.
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { defineSpeechProvider, type SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import { createPrincipal } from "../../ui-server/src/db/principals.js";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.ts";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Dictation selection runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING dictation selection runtime proof: no Chrome; Settings › Voice and take binding are unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
const SECRET = "dictation-selection-runtime-secret-0123456789";
const WIDTHS = [320, 1280] as const;
const SHOTS = process.env.BRAIN_DICTATION_SCREENSHOTS;
const hook = runtimeHookPhases("dictation-selection-runtime");

type Id = "alpha" | "beta" | "gamma";
const streaming = { streaming: true, interimResults: true, keyterms: false, endpointing: false };
/** What each double did, observed on the server side. */
const minted: Record<Id, number> = { alpha: 0, beta: 0, gamma: 0 };
/** Which double transcribed each saved recording, in order, as the server dispatched it. */
const transcribed: Id[] = [];
const held: Partial<Record<Id, { arrive: () => void; gate: Promise<void> }>> = {};
const sockets: Array<{ provider: string; open: boolean }> = [];
const log: Array<{ method: string; path: string; body?: string }> = [];
/** The `Speech-Provider` each saved-recording upload named. */
const uploads: Array<string | null> = [];

function provider(id: Id): SpeechProvider {
  const base = {
    id,
    createSession: async () => {
      minted[id]++;
      const hold = held[id];
      if (hold) { hold.arrive(); await hold.gate; }
      return { url: `ws://127.0.0.1:${speech!.port}/?provider=${id}`, expiresAt: Date.now() + 60_000 };
    },
  };
  const transcribeRecording = async () => { transcribed.push(id); return { text: `Transcribed by ${id}` }; };
  return id === "alpha"
    ? defineSpeechProvider({ ...base, label: "Alpha Transcribe", destination: "Microphone audio streams from this browser to Alpha, a fixture service.", capabilities: { ...streaming, smartTranscription: false }, transcribeRecording })
    : id === "gamma"
    ? defineSpeechProvider({ ...base, label: "Gamma Archive", destination: "Microphone audio streams from this browser to Gamma, a fixture service.", capabilities: { ...streaming, smartTranscription: false }, transcribeRecording })
    : defineSpeechProvider({ ...base, label: "Beta Live", destination: "Microphone audio streams from this browser to Beta, a fixture service.", capabilities: { ...streaming, smartTranscription: true } });
}

/** Holds the next mint of `id` until released; `reached` settles once the server is inside it. */
function holdMint(id: Id) {
  let arrive!: () => void, release!: () => void;
  const reached = new Promise<void>((yes) => { arrive = yes; });
  const gate = new Promise<void>((yes) => { release = yes; });
  held[id] = { arrive, gate };
  return { reached, release: () => { delete held[id]; release(); } };
}

let fixture = "", brain = "", assets = "", origin = "", port = 0;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let speech: ReturnType<typeof Bun.serve<{ provider: string; record: { provider: string; open: boolean } }>> | undefined;
let browser: Browser | undefined;
const cookies = { owner: "", reader: "" };

async function start(providers: Id[]) {
  app = await hook.phase("host-start", () => createApp({
    config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(fixture, "ui.db"),
      AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1",
      HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([makeFakeBackend({ id: "dictation-fixture" })], "dictation-fixture"),
    staticRoot: assets, observability: createRecordingObservability(),
    ...(providers.length ? { speechProviders: providers.map(provider) } : {}),
  }));
  const current = app;
  const handle = async (request: Request, bun: unknown) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/voice/")) log.push({ method: request.method, path: url.pathname, ...(request.method === "POST" && url.pathname === "/api/voice/session" ? { body: await request.clone().text() } : {}) });
    if (request.method === "PUT" && url.pathname.endsWith("/transcription")) uploads.push(request.headers.get("speech-provider"));
    return current.fetch(request, bun as never);
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

/** The server restarts over the same database, origin and device storage. */
async function restart(providers: Id[]) {
  server?.stop(true);
  await app?.close();
  await start(providers);
}

beforeAll(async () => {
  if (!executablePath) return;
  await runtimePackageBuild(repo, ["ui-react", "ui-server", "core"], hook);
  fixture = await mkdtemp(resolve(tmpdir(), "odysseus-dictation-selection-"));
  brain = resolve(fixture, "brain");
  await mkdir(resolve(brain, "notes"), { recursive: true });
  await writeFile(resolve(brain, "notes", "ithaca.md"), "# Ithaca\n\nOdysseus is expected home on 2026-07-12.\n");
  assets = resolve(fixture, "assets");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const r=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!r.success){console.error(r.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/dictation-selection-client.tsx"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await hook.child("client-build", bundle);
  if (code !== 0) throw new Error(`Dictation selection client build failed (${code}): ${out}\n${err}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Odysseus dictation</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}body{background:var(--bk-color-canvas);color:var(--bk-color-ink)}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  speech = Bun.serve<{ provider: string; record: { provider: string; open: boolean } }>({ hostname: "127.0.0.1", port: 0,
    fetch(request, bun) {
      const providerId = new URL(request.url).searchParams.get("provider") ?? "unknown";
      return bun.upgrade(request, { data: { provider: providerId, record: { provider: providerId, open: true } } }) ? undefined : new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      open(socket) { sockets.push(socket.data.record); },
      message(socket, message) {
        if (typeof message !== "string") return;
        socket.send(JSON.stringify({ type: "final", text: `Heard by ${socket.data.provider}`, endsTurn: false }));
        socket.send(JSON.stringify({ type: "drained" }));
      },
      close(socket) { socket.data.record.open = false; },
    },
  });
  await start(["alpha", "beta"]);
  const owner = createPrincipal(app!.db, { authMethod: "password", label: "Penelope's phone", ttlSeconds: 3600 });
  const reader = createPrincipal(app!.db, { authMethod: "delegated", createdBy: owner.id, label: "Telemachus agent", ttlSeconds: 3600 });
  for (const [who, principal] of [["owner", owner], ["reader", reader]] as const) {
    const signed = await generateSignedCookie("brain_ui_session", principal.id, SECRET);
    cookies[who] = signed.split(";")[0]!.slice("brain_ui_session=".length);
  }
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }));
}, 240_000);

afterAll(() => hook.phase("cleanup", async () => {
  await device?.close();
  await browser?.close();
  server?.stop(true);
  speech?.stop(true);
  await app?.close();
  if (fixture) await rm(fixture, { recursive: true, force: true });
}));

/** The saved choice as another device changes it, through the real route. */
async function otherDevice(defaultProvider: string | null, smart = true) {
  const headers = { cookie: `brain_ui_session=${cookies.owner}`, origin, "content-type": "application/json" };
  const current = await (await fetch(`${origin}/api/voice/dictation/settings`, { headers })).json() as { revision: string };
  const response = await fetch(`${origin}/api/voice/dictation/settings`, { method: "PUT", headers: { ...headers, "if-match": `"${current.revision}"` }, body: JSON.stringify({ defaultProvider, smart }) });
  expect(response.status, "the other device saved").toBe(200);
}

const contexts: BrowserContext[] = [];
async function newDevice(width: number, who: "owner" | "reader"): Promise<BrowserContext> {
  const context = await browser!.newContext({ viewport: { width, height: width < 900 ? 720 : 860 }, hasTouch: width < 900 });
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
  return context;
}
async function open(width: number, who: "owner" | "reader" = "owner", context?: BrowserContext): Promise<Page> {
  if (!context) contexts.push(context = await newDevice(width, who));
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction("window.__dictation?.ready()");
  return page;
}
async function closeAll() { for (const context of contexts.splice(0)) await context.close(); }
/** One owner device that outlives a test, as a phone outlives a server restart. */
let device: BrowserContext | undefined;

const gum = (page: Page) => page.evaluate(() => (window as unknown as { __gum: number }).__gum);
const state = (page: Page) => page.evaluate(() => (window as unknown as { __dictation: { state(): { mode: string; connecting: boolean; gate: string | null; target: string | null; providerId: string | null; reviewText: string; clients: Array<{ providerId: string; session: string; tracks: string[] }> } } }).__dictation.state());
const sessions = () => log.filter((entry) => entry.method === "POST" && entry.path === "/api/voice/session");
type DiscoveryView = { __dictation: { state(): { save: { refreshFailed: boolean }; discovery: { at: number } | null } } };
/**
 * Opens Settings › Voice and waits until the read the pane makes on opening
 * has answered. A snapshot the composer already holds ends `aria-busy` at
 * once, while that read is still on its way and can publish a newer revision
 * after a test has changed the server.
 */
async function settings(page: Page) {
  const before = await page.evaluate(() => (window as unknown as DiscoveryView).__dictation.state().discovery?.at ?? 0);
  await page.evaluate(() => (window as unknown as { __dictation: { openSettings(tab: string): void } }).__dictation.openSettings("voice"));
  const pane = page.locator("[data-dictation-settings]");
  await pane.waitFor();
  await page.waitForFunction(() => !document.querySelector("[data-dictation-settings]")?.getAttribute("aria-busy"));
  await page.waitForFunction((at) => { const s = (window as unknown as DiscoveryView).__dictation.state(); return s.save.refreshFailed || (s.discovery?.at ?? 0) > at; }, before);
  return pane;
}
async function closeSettings(page: Page) {
  await page.evaluate(() => (window as unknown as { __dictation: { closeSettings(): void } }).__dictation.closeSettings());
}
const puts = () => log.filter((entry) => entry.method === "PUT" && entry.path === "/api/voice/dictation/settings").length;
/**
 * Runs a Settings action that saves, and waits until the server received it,
 * the write's outcome is in the root and discovery was read again after it.
 * The pane's own `role=status` is not the signal: during a take the first one
 * is the active-take notice, which is there before the save completes.
 */
async function saves(page: Page, action: () => Promise<unknown>) {
  const before = puts();
  await action();
  for (let waited = 0; puts() <= before; waited += 10) { if (waited > 10_000) throw new Error("No settings save reached the server"); await Bun.sleep(10); }
  await page.waitForFunction(() => {
    const { save, discovery } = (window as unknown as { __dictation: { state(): { save: { pending: boolean; status: string | null; refreshFailed: boolean }; discovery: { stale: boolean } | null } } }).__dictation.state();
    return !save.pending && save.status !== "saving" && discovery !== null && (!discovery.stale || save.refreshFailed);
  });
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  // Let sheets and switches finish their transitions.
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}
/** No horizontal page scroll, and every control in the selector at least 44px tall. */
async function fits(page: Page, width: number, selector: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(overflow, `no horizontal scroll at ${width}px`).toBeLessThanOrEqual(width);
  const heights = await page.locator(selector).evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  for (const height of heights) expect(height, `${selector} target at ${width}px`).toBeGreaterThanOrEqual(44);
}
const mic = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/**
 * The take is capturing: its client's microphone track is live and its start
 * finished, so its socket is open. A client publishes its track before it
 * awaits the socket, so a live track alone can still precede the socket.
 */
const live = (page: Page) => page.waitForFunction(() => { const s = (window as unknown as { __dictation: { state(): { connecting: boolean; clients: Array<{ tracks: string[] }> } } }).__dictation.state(); return !s.connecting && s.clients.at(-1)?.tracks.includes("live"); });
/** The speech server's record of the first socket opened after `count` were known. */
async function socketAfter(count: number) {
  for (let waited = 0; sockets.length <= count; waited += 10) { if (waited > 10_000) throw new Error("No new speech socket reached the server"); await Bun.sleep(10); }
  return sockets[count]!;
}
const idle = (page: Page) => page.waitForFunction(() => (window as unknown as { __dictation: { state(): { mode: string } } }).__dictation.state().mode === "idle");
/** One complete take, acknowledging the service on this device first if it asks. */
async function take(page: Page, name: string) {
  await mic(page, name).click();
  const card = page.locator('[data-dictation-gate="consent"]');
  await Promise.race([card.waitFor(), live(page)]);
  if (await card.count()) await page.getByRole("button", { name: "Start dictation" }).click();
  await live(page);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await idle(page);
}

describe.skipIf(!executablePath)("Settings › Voice and the next take, against mounted routes", () => {
  for (const width of WIDTHS) test(`${width}px: choosing, SMART, reload and persistence never touch a microphone, a session or a provider`, async () => {
    await otherDevice(null);
    const before = { sessions: sessions().length, alpha: minted.alpha, beta: minted.beta };
    const page = await open(width);
    try {
      const pane = await settings(page);
      expect(await pane.locator("[data-dictation-choose]").textContent()).toBe("Choose a dictation service");
      expect(await pane.getByRole("radio", { checked: true }).count(), "nothing is checked").toBe(0);
      expect(await pane.getByRole("switch").count(), "no SMART switch without an effective SMART service").toBe(0);
      await fits(page, width, "[data-dictation-provider]");
      await shot(page, `voice-choose-${width}`);

      // Keyboard: focus the first radio, select it with Space, move with the arrows.
      const alpha = pane.getByRole("radio", { name: /^Alpha Transcribe/ });
      await alpha.focus();
      await saves(page, () => page.keyboard.press("Space"));
      expect(await alpha.isChecked()).toBe(true);
      expect(await pane.locator('[data-dictation-provider="alpha"]').textContent()).toContain("saved");
      await saves(page, () => page.keyboard.press("ArrowDown"));
      const beta = pane.getByRole("radio", { name: /^Beta Live/ });
      expect(await beta.isChecked(), "arrowing saves the next service immediately").toBe(true);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("value")), "focus stays on the chosen radio").toBe("beta");
      const smart = pane.getByRole("switch", { name: "Clean up as I speak" });
      expect(await smart.getAttribute("aria-checked"), "D1: on by default").toBe("true");
      await saves(page, () => smart.click());
      expect(await smart.getAttribute("aria-checked")).toBe("false");
      await fits(page, width, "[data-dictation-provider]");
      await shot(page, `voice-saved-smart-${width}`);

      await page.reload();
      await page.waitForFunction("window.__dictation?.ready()");
      const again = await settings(page);
      expect(await again.getByRole("radio", { name: /^Beta Live/ }).isChecked(), "the saved choice survives reload").toBe(true);
      expect(await again.getByRole("switch", { name: "Clean up as I speak" }).getAttribute("aria-checked"), "and so does SMART off").toBe("false");
      expect(await gum(page), "SETTINGS_OPENS_NO_MICROPHONE").toBe(0);
    } finally { await closeAll(); }
    expect(sessions().length, "SETTINGS_REQUESTS_NO_SESSION").toBe(before.sessions);
    expect([minted.alpha, minted.beta], "SETTINGS_CALLS_NO_PROVIDER").toEqual([before.alpha, before.beta]);
  }, 90_000);

  for (const width of WIDTHS) test(`${width}px: the first take shows where audio goes before any session or microphone; later takes start at once`, async () => {
    await otherDevice("alpha");
    const page = await open(width);
    try {
      const dictate = mic(page, "Dictate · Alpha Transcribe");
      await dictate.waitFor();
      const before = sessions().length;
      await dictate.click();
      const card = page.locator('[data-dictation-gate="consent"]');
      // Whichever comes first: the card, or a session request that must not happen.
      await Promise.race([card.waitFor(), (async () => { while (sessions().length === before) await Bun.sleep(10); })()]);
      expect(sessions().length, "NO_SESSION_BEFORE_START_DICTATION").toBe(before);
      expect(await card.textContent()).toContain("Dictation goes to Alpha Transcribe");
      expect(await card.textContent()).toContain("Microphone audio streams from this browser to Alpha, a fixture service.");
      await page.waitForFunction(() => document.activeElement?.textContent === "Start dictation");
      await fits(page, width, '[data-dictation-gate] button, [data-dictation-gate] [role="button"]');
      await shot(page, `acknowledge-${width}`);
      expect(await gum(page), "NO_MICROPHONE_BEFORE_START_DICTATION").toBe(0);

      await page.keyboard.press("Escape");
      await page.waitForFunction(() => (window as unknown as { __dictation: { state(): { mode: string } } }).__dictation.state().mode === "idle");
      expect(sessions().length, "Escape opens nothing").toBe(before);
      expect(await gum(page)).toBe(0);

      const known = sockets.length;
      await dictate.click();
      await card.waitFor();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => { const s = (window as unknown as { __dictation: { state(): { connecting: boolean; clients: Array<{ tracks: string[] }> } } }).__dictation.state(); return !s.connecting && s.clients.at(-1)?.tracks.includes("live"); });
      expect(sessions().slice(before).map((entry) => JSON.parse(entry.body!)), "the disclosed service is requested").toEqual([{ providerId: "alpha", smart: true }]);
      expect(await socketAfter(known), "the server says the take reached alpha").toEqual({ provider: "alpha", open: true });
      expect(await page.getByText("To Alpha Transcribe", { exact: true }).count()).toBe(1);
      await shot(page, `listening-${width}`);
      // Start dictation left the page; the keyboard carries on to Done.
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim()), "FOCUS_CONTINUES_ON_DONE").toBe("Done");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => (window as unknown as { __dictation: { state(): { reviewText: string } } }).__dictation.state().reviewText === "Heard by alpha");

      // Reload: the acknowledgement is device-local and persists.
      await page.reload();
      await page.waitForFunction("window.__dictation?.ready()");
      const count = sessions().length;
      await mic(page, "Dictate · Alpha Transcribe").click();
      await page.waitForFunction(() => (window as unknown as { __dictation: { state(): { connecting: boolean; mode: string } } }).__dictation.state().mode === "dictate");
      await page.waitForFunction(() => !(window as unknown as { __dictation: { state(): { connecting: boolean } } }).__dictation.state().connecting);
      expect((await state(page)).gate, "no card for an acknowledged service").toBeNull();
      expect(sessions().length).toBe(count + 1);
      await page.getByRole("button", { name: "Done", exact: true }).click();
    } finally { await closeAll(); }
  }, 90_000);

  test("a default saved elsewhere after disclosure never retargets the take: the disclosed id is minted", async () => {
    await otherDevice("alpha");
    const page = await open(1280);
    try {
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.waitForFunction("window.__dictation?.ready()");
      await mic(page, "Dictate · Alpha Transcribe").click();
      await page.locator('[data-dictation-gate="consent"]').waitFor();
      // Another device chooses Beta while this card names Alpha.
      await otherDevice("beta");
      const before = { sessions: sessions().length, alpha: minted.alpha, beta: minted.beta, sockets: sockets.length };
      await page.getByRole("button", { name: "Start dictation" }).click();
      while (sessions().length === before.sessions) await Bun.sleep(10);
      expect(sessions().slice(before.sessions).map((entry) => entry.body ? JSON.parse(entry.body).providerId : null), "RACE_DISCLOSED_PROVIDER_IS_SENT").toEqual(["alpha"]);
      await live(page);
      expect([minted.alpha - before.alpha, minted.beta - before.beta], "only alpha minted").toEqual([1, 0]);
      expect(await socketAfter(before.sockets)).toEqual({ provider: "alpha", open: true });
      expect((await state(page)).target).toBe("alpha");
      await page.getByRole("button", { name: "Done", exact: true }).click();

      // A held mint crosses another change; the response still names alpha.
      await otherDevice("alpha");
      await page.reload();
      await page.waitForFunction("window.__dictation?.ready()");
      const hold = holdMint("alpha");
      const mintedBefore = { alpha: minted.alpha, beta: minted.beta };
      await mic(page, "Dictate · Alpha Transcribe").click();
      await hold.reached;
      await otherDevice("beta");
      hold.release();
      await page.waitForFunction(() => (window as unknown as { __dictation: { state(): { clients: Array<{ tracks: string[] }> } } }).__dictation.state().clients.at(-1)?.tracks.includes("live"));
      expect([minted.alpha - mintedBefore.alpha, minted.beta - mintedBefore.beta], "the held take stays with alpha").toEqual([1, 0]);
      expect((await state(page)).providerId).toBe("alpha");
      await page.getByRole("button", { name: "Done", exact: true }).click();
    } finally { await closeAll(); }
  }, 90_000);

  test("saving during an active take leaves its socket and adapter alone and says when the change applies", async () => {
    await otherDevice("alpha");
    const page = await open(1280);
    try {
      await take(page, "Dictate · Alpha Transcribe");
      const known = sockets.length;
      await mic(page, "Dictate · Alpha Transcribe").click();
      await live(page);
      // This take's own socket, never the previous take's closed one.
      const socket = await socketAfter(known);
      expect(sockets.length, "one socket for this take").toBe(known + 1);
      const before = { sessions: sessions().length, clients: (await state(page)).clients.length };
      const pane = await settings(page);
      await saves(page, () => pane.getByRole("radio", { name: /^Beta Live/ }).check());
      await pane.locator("[data-dictation-take]").waitFor();
      expect(await pane.locator("[data-dictation-take]").textContent()).toBe("Dictating with Alpha Transcribe now. Your change applies to the next take.");
      await shot(page, "active-take-1280");
      expect(socket, "ACTIVE_TAKE_SOCKET_INTACT").toEqual({ provider: "alpha", open: true });
      const during = await state(page);
      expect(during.clients.length, "no new adapter").toBe(before.clients);
      expect(during.clients.at(-1)!.tracks, "the microphone keeps capturing").toEqual(["live"]);
      expect(during.target).toBe("alpha");
      expect(sessions().length, "no new session").toBe(before.sessions);
      await closeSettings(page);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction(() => (window as unknown as { __dictation: { state(): { mode: string } } }).__dictation.state().mode === "idle");
      // The next take goes to Beta, which this device has not acknowledged.
      await mic(page, "Dictate · Beta Live").click();
      await page.locator('[data-dictation-gate="consent"]').waitFor();
      expect(await page.locator('[data-dictation-gate="consent"]').textContent()).toContain("Dictation goes to Beta Live");
      await page.getByRole("button", { name: "Start dictation" }).click();
      await page.waitForFunction(() => (window as unknown as { __dictation: { state(): { clients: Array<{ tracks: string[] }> } } }).__dictation.state().clients.at(-1)?.tracks.includes("live"));
      expect(JSON.parse(sessions().at(-1)!.body!), "SMART travels with a SMART service").toEqual({ providerId: "beta", smart: true });
      await page.getByRole("button", { name: "Done", exact: true }).click();
    } finally { await closeAll(); }
  }, 90_000);

  test("cancelling while the session is minted opens no microphone and no adapter", async () => {
    await otherDevice("alpha");
    const page = await open(1280);
    try {
      await take(page, "Dictate · Alpha Transcribe");
      const before = { clients: (await state(page)).clients.length, gum: await gum(page) };
      const hold = holdMint("alpha");
      await mic(page, "Dictate · Alpha Transcribe").click();
      await hold.reached;
      await page.getByRole("button", { name: "Cancel dictation" }).click();
      hold.release();
      await idle(page);
      await Bun.sleep(300);
      expect((await state(page)).clients.length, "no adapter after a cancelled mint").toBe(before.clients);
      expect(await gum(page), "no microphone after a cancelled mint").toBe(before.gum);
    } finally { await closeAll(); }
  }, 60_000);

  test("stale revision, a failed save with Try again, and the read-only view for a non-owner", async () => {
    await otherDevice("alpha");
    const page = await open(1280);
    try {
      const pane = await settings(page);
      // Changed on another device twice: the value is back to alpha, the revision is not.
      await otherDevice("beta"); await otherDevice("alpha");
      // click, not check: the choice is refused and reverts, and `check()`
      // fails when that revert lands before it reads the radio back (#3759).
      await pane.getByRole("radio", { name: /^Beta Live/ }).click();
      await page.getByText("Changed on another device. Showing the current choice.").waitFor();
      expect(await pane.getByRole("radio", { name: /^Alpha Transcribe/ }).isChecked(), "the current value is reloaded").toBe(true);
      await shot(page, "stale-1280");

      let fail = true;
      await page.route("**/api/voice/dictation/settings", (route) => route.request().method() === "PUT" && fail ? route.fulfill({ status: 500, json: { error: "Fixture failure" } }) : route.continue());
      await pane.getByRole("radio", { name: /^Beta Live/ }).click();
      await pane.getByRole("alert").waitFor();
      expect(await pane.getByRole("alert").textContent()).toContain("Couldn't save. Your dictation service is unchanged.");
      expect(await pane.getByRole("radio", { name: /^Alpha Transcribe/ }).isChecked(), "a failed save reverts").toBe(true);
      await shot(page, "save-failed-1280");
      fail = false;
      await saves(page, () => pane.getByRole("button", { name: "Try again" }).click());
      expect(await pane.getByRole("radio", { name: /^Beta Live/ }).isChecked(), "Try again saves the same choice").toBe(true);
      expect(await pane.getByRole("alert").count()).toBe(0);
    } finally { await closeAll(); }

    for (const width of WIDTHS) {
      const reader = await open(width, "reader");
      try {
        const writes = puts();
        const pane = await settings(reader);
        // Until the pane's own probe answers, unknown authority already keeps every control disabled.
        for (const radio of await pane.getByRole("radio").all()) expect(await radio.isDisabled(), "DISABLED_WHILE_AUTHORITY_UNKNOWN").toBe(true);
        // Before anything is tried, the controls say who can change them. The
        // probe answers on its own schedule, after discovery may have loaded.
        await pane.locator("[data-dictation-owner]").waitFor({ timeout: 10_000 }).catch(() => {});
        expect(await pane.locator("[data-dictation-owner]").count(), "READ_ONLY_BEFORE_ANY_SAVE").toBe(1);
        expect(await pane.locator("[data-dictation-owner]").textContent()).toBe("Only the owner can change this.");
        const radios = await pane.getByRole("radio").all();
        expect(radios.length).toBe(2);
        for (const radio of radios) expect(await radio.isDisabled(), "READ_ONLY_BEFORE_ANY_SAVE").toBe(true);
        await pane.locator('[data-dictation-provider="alpha"]').click({ force: true });
        await reader.waitForTimeout(200);
        expect(puts(), "a non-owner's view attempts no write").toBe(writes);
        expect(await pane.getByRole("radio", { name: /^Beta Live/ }).isChecked(), "the server value stands").toBe(true);
        for (const radio of await pane.getByRole("radio").all()) expect(await radio.isDisabled()).toBe(true);
        await shot(reader, `read-only-${width}`);
      } finally { await closeAll(); }
    }
    const saved = await (await fetch(`${origin}/api/voice/dictation/settings`, { headers: { cookie: `brain_ui_session=${cookies.owner}` } })).json() as { defaultProvider: string };
    expect(saved.defaultProvider, "the non-owner changed nothing").toBe("beta");
  }, 120_000);

  test("a removed saved service blocks dictation with Open Settings and no fallback; zero and one service", async () => {
    // This device acknowledges alpha before the restart.
    await otherDevice("alpha");
    device = await newDevice(1280, "owner");
    const first = await open(1280, "owner", device);
    await take(first, "Dictate · Alpha Transcribe");
    await first.close();
    await otherDevice("beta");
    await restart(["alpha"]);
    for (const width of WIDTHS) {
      const page = await open(width);
      try {
        const before = { sessions: sessions().length, alpha: minted.alpha };
        await mic(page, "Dictate").click();
        const blocked = page.locator('[data-dictation-gate="blocked"]');
        await blocked.waitFor();
        expect(await blocked.textContent()).toContain("Your dictation service isn't available");
        expect(await blocked.textContent()).toContain("beta isn't available on this host.");
        await fits(page, width, '[data-dictation-gate] button, [data-dictation-gate] [role="button"]');
        await shot(page, `blocked-unavailable-${width}`);
        await page.getByRole("button", { name: "Open Settings" }).click();
        const pane = page.locator("[data-dictation-settings]");
        await pane.waitFor();
        await pane.locator("[data-dictation-unavailable]").waitFor();
        expect(await pane.locator("[data-dictation-unavailable]").textContent()).toContain("Saved choice · not available");
        expect(await pane.getByRole("radio", { checked: true }).count(), "nothing is chosen in its place").toBe(0);
        await shot(page, `voice-unavailable-${width}`);
        expect(sessions().length, "NO_FALLBACK_SESSION").toBe(before.sessions);
        expect(minted.alpha, "alpha is never used in beta's place").toBe(before.alpha);
        expect(await gum(page)).toBe(0);
      } finally { await closeAll(); }
    }
    const page = await open(1280, "owner", device);
    try {
      const pane = await settings(page);
      // Choosing the only available service leaves one read-only row.
      await pane.getByRole("radio", { name: /^Alpha Transcribe/ }).click();
      await pane.locator("[data-dictation-only]").waitFor();
      expect(await pane.locator("[data-dictation-unavailable]").count()).toBe(0);
      await closeSettings(page);
      await mic(page, "Dictate · Alpha Transcribe").click();
      await live(page);
      expect((await state(page)).gate, "the device's earlier acknowledgement survived the restart").toBeNull();
      await page.getByRole("button", { name: "Done", exact: true }).click();
    } finally { await device.close(); device = undefined; }

    await restart([]);
    for (const width of WIDTHS) {
      const page = await open(width);
      try {
        const pane = await settings(page);
        expect(await pane.locator("[data-dictation-empty]").textContent()).toBe("Dictation isn't set up on this host.");
        expect(await pane.getByRole("radio").count()).toBe(0);
        await shot(page, `voice-none-${width}`);
        await closeSettings(page);
        // Plan §7: no service at all disables the mic, which says why.
        const dictate = mic(page, "Dictate");
        expect(await dictate.getAttribute("aria-disabled"), "ZERO_PROVIDERS_DISABLE_THE_MIC").toBe("true");
        expect(await dictate.evaluate((node) => document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent), "the mic explains why").toBe("Dictation isn't set up on this host.");
        await dictate.hover();
        await shot(page, `mic-unavailable-${width}`);
        await dictate.click({ force: true });
        await dictate.focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(200);
        expect((await state(page)).mode, "a disabled mic opens nothing").toBe("idle");
        expect(await page.locator("[data-dictation-gate]").count()).toBe(0);
      } finally { await closeAll(); }
    }

    await restart(["beta"]);
    await otherDevice(null);
    for (const width of WIDTHS) {
      const page = await open(width);
      try {
        const pane = await settings(page);
        await pane.locator("[data-dictation-only]").waitFor();
        expect(await pane.locator("[data-dictation-only]").textContent()).toContain("The only dictation service on this host.");
        expect(await pane.getByRole("switch", { name: "Clean up as I speak" }).count(), "SMART shows for the only SMART service").toBe(1);
        await shot(page, `voice-only-${width}`);
      } finally { await closeAll(); }
    }
    await restart(["alpha", "beta"]);
  }, 180_000);

  for (const width of WIDTHS) test(`${width}px: a choice queued behind a slow save is written after Settings closes`, async () => {
    await otherDevice("alpha");
    const page = await open(width);
    try {
      const pane = await settings(page);
      // Hold Beta's write at the browser until the pane has closed.
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      await page.route("**/api/voice/dictation/settings", async (route) => {
        if (route.request().method() === "PUT" && first) { first = false; await held; }
        await route.continue();
      });
      const before = puts();
      await pane.getByRole("radio", { name: /^Beta Live/ }).check();
      await pane.getByRole("radio", { name: /^Alpha Transcribe/ }).check();
      await closeSettings(page);
      await page.locator("[data-dictation-settings]").waitFor({ state: "hidden" }).catch(() => {});
      release();
      for (let waited = 0; puts() < before + 2; waited += 10) { if (waited > 10_000) break; await Bun.sleep(10); }
      expect(puts() - before, "QUEUED_CHOICE_SURVIVES_CLOSE: both accepted choices reach the server").toBe(2);
      // The request is logged as it arrives; give the server its moment to write.
      let saved = "";
      for (let waited = 0; saved !== "alpha" && waited < 5_000; waited += 50) {
        saved = (await (await fetch(`${origin}/api/voice/dictation/settings`, { headers: { cookie: `brain_ui_session=${cookies.owner}` } })).json() as { defaultProvider: string }).defaultProvider;
        if (saved !== "alpha") await Bun.sleep(50);
      }
      expect(saved, "the last choice is the one that stands").toBe("alpha");
    } finally { await closeAll(); }
  }, 60_000);

  test("a save whose follow-up read fails is what the next take uses, and the pane says the read failed", async () => {
    await otherDevice("alpha");
    const page = await open(1280);
    try {
      await take(page, "Dictate · Alpha Transcribe");
      const pane = await settings(page);
      let failReads = false;
      await page.route("**/api/voice/providers", (route) => failReads ? route.abort("failed") : route.continue());
      failReads = true;
      // "Saving…" clears only once the follow-up read has settled.
      await saves(page, () => pane.getByRole("radio", { name: /^Beta Live/ }).check());
      expect(await pane.getByText("Couldn't check the dictation services just now. What's shown may be out of date.").count(), "REFRESH_FAILURE_IS_SHOWN").toBe(1);
      expect(await pane.getByRole("radio", { name: /^Beta Live/ }).isChecked(), "the confirmed choice is shown").toBe(true);
      await closeSettings(page);
      failReads = false;
      const before = sessions().length;
      await page.getByRole("button", { name: /^Dictate/ }).click();
      const card = page.locator('[data-dictation-gate="consent"]');
      await Promise.race([card.waitFor(), (async () => { while (sessions().length === before) await Bun.sleep(10); })()]);
      expect(sessions().slice(before).map((entry) => JSON.parse(entry.body!).providerId), "TAKE_AFTER_SAVE_USES_CONFIRMED_PROVIDER: nothing goes to the older choice").toEqual([]);
      expect(await card.textContent()).toContain("Dictation goes to Beta Live");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await idle(page);
    } finally { await closeAll(); }
  }, 60_000);

  for (const width of WIDTHS) test(`${width}px: each tray confirmation names the current service, keeps it through upload, and a removed one is confirmed afresh`, async () => {
    await restart(["alpha", "beta", "gamma"]);
    await otherDevice("alpha");
    const page = await open(width);
    const recording = page.locator("[data-recordings-tray]");
    const confirmation = page.locator('[role="group"][aria-label^="Upload recording"]');
    try {
      await page.evaluate(() => (window as unknown as { __dictation: { seedRecording(): Promise<void> } }).__dictation.seedRecording());
      await recording.locator("button").first().click();
      await page.getByRole("button", { name: /^Transcribe recording/ }).waitFor();

      // The item is mounted (and was told Alpha). Settings switches to Gamma.
      let pane = await settings(page);
      await saves(page, () => pane.getByRole("radio", { name: /^Gamma Archive/ }).check());
      await closeSettings(page);
      await page.getByRole("button", { name: /^Transcribe recording/ }).click();
      expect(await confirmation.textContent(), "TRAY_CONFIRMATION_NAMES_CURRENT_SERVICE").toContain("Your server sends it to Gamma Archive.");
      await fits(page, width, '[role="group"][aria-label^="Upload recording"] label');

      // Settings changes while the confirmation is open: it keeps what it disclosed.
      pane = await settings(page);
      await saves(page, () => pane.getByRole("radio", { name: /^Alpha Transcribe/ }).check());
      await closeSettings(page);
      expect(await confirmation.textContent(), "TRAY_CONFIRMATION_KEEPS_ITS_TARGET").toContain("Your server sends it to Gamma Archive.");
      const sent = { uploads: uploads.length, transcribed: transcribed.length };
      await page.getByRole("button", { name: "Upload and transcribe" }).click();
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-recordings-tray] textarea")?.value === "Transcribed by gamma");
      expect(uploads.slice(sent.uploads), "the upload names the confirmed service").toEqual(["gamma"]);
      expect(transcribed.slice(sent.transcribed), "TRAY_DISPATCHED_PROVIDER: the server transcribed with Gamma").toEqual(["gamma"]);

      // A second recording, confirmed for Gamma; then the host drops Gamma.
      await page.getByRole("button", { name: /^Discard/ }).first().click();
      await page.getByRole("button", { name: /^Delete recording/ }).click();
      await page.evaluate(() => (window as unknown as { __dictation: { seedRecording(): Promise<void> } }).__dictation.seedRecording());
      await otherDevice("gamma");
      pane = await settings(page);
      await closeSettings(page);
      // The host restarts without Gamma. This device's snapshot, read moments
      // ago, still names it; a reconnect asks for consent again anyway.
      await restart(["alpha", "beta"]);
      await page.waitForFunction("window.__dictation?.ready()");
      await recording.locator("button").first().waitFor();
      if (!await page.getByRole("button", { name: /^Transcribe recording/ }).isVisible()) await recording.locator("button").first().click();
      await page.getByRole("button", { name: /^Transcribe recording/ }).click();
      expect(await confirmation.textContent(), "the confirmation names what this device last read").toContain("Your server sends it to Gamma Archive.");
      const refused = { uploads: uploads.length, transcribed: transcribed.length };
      await page.getByRole("button", { name: "Upload and transcribe" }).click();
      await page.getByText("That dictation service isn't available on this host.").first().waitFor();
      expect(uploads.slice(refused.uploads), "one refused upload, and no automatic second one").toEqual(["gamma"]);
      expect(transcribed.length, "nothing was transcribed in Gamma's place").toBe(refused.transcribed);

      // The next confirmation is resolved from what the host has now, and asks again.
      await page.getByRole("button", { name: /^Transcribe recording/ }).click();
      await confirmation.waitFor();
      expect(await confirmation.textContent(), "STALE_PROVIDER_RECOVERY_NAMES_CURRENT").not.toContain("Gamma");
      const choice = confirmation.getByRole("radio", { name: "Alpha Transcribe" });
      expect(await choice.isChecked(), "the one capable service is offered").toBe(true);
      await fits(page, width, '[role="group"][aria-label^="Upload recording"] label');
      expect(uploads.length, "a new destination waits for an explicit confirmation").toBe(refused.uploads + 1);
      await page.getByRole("button", { name: "Upload and transcribe" }).click();
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-recordings-tray] textarea")?.value === "Transcribed by alpha");
      expect(uploads.slice(refused.uploads), "the recovery upload names Alpha").toEqual(["gamma", "alpha"]);
      expect(transcribed.slice(refused.transcribed), "and the server transcribed with Alpha").toEqual(["alpha"]);
      await shot(page, `tray-recovered-${width}`);
    } finally {
      await closeAll();
      await otherDevice("alpha");
      await restart(["alpha", "beta"]);
    }
  }, 120_000);
});
