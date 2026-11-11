import { runtimePackageBuild } from "./fixtures/runtime-package-build";
// #3698: the Start card in real Chrome against a real password-mode server.
// Two keyless live-service doubles stand in for Gemini Live and GPT-Live,
// each with its own voices and instruction cap; personas are Markdown files
// in an Odysseus brain. The server records every `open` and the options it
// was given, and the page records every frame it sent, so the card's
// disclosure is checked against what Start actually echoed. Every state runs
// at 320px and 1280px. Nothing leaves loopback.
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
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Start card runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING Start card runtime proof: no Chrome; the Start card is unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
const SECRET = "start-card-runtime-secret-0123456789";
/** The phone the card must fit (#3698), and a desktop. */
const SIZES = [[320, 640], [1280, 860]] as const;
const SHOTS = process.env.BRAIN_START_CARD_SCREENSHOTS;
const hook = runtimeHookPhases("start-card-runtime");

type Id = "gemini-live" | "gpt-live";
const SPEECH: Record<Id, Pick<LiveConversationProvider, "voices" | "defaultVoice" | "personaInstructionBytes">> = {
  "gemini-live": { voices: [{ id: "Kore", label: "Kore" }, { id: "Puck", label: "Puck" }], defaultVoice: "Kore", personaInstructionBytes: 2_000 },
  "gpt-live": { voices: [{ id: "marin", label: "marin" }, { id: "cedar", label: "cedar" }], defaultVoice: "marin", personaInstructionBytes: 1_500 },
};
/** Every session each double opened, across restarts. */
const opened: Record<Id, FakeLiveSession[]> = { "gemini-live": [], "gpt-live": [] };
function double(id: Id): LiveConversationProvider {
  const fake = fakeLiveProvider();
  const voiceService = id === "gemini-live" ? "Fictional Gemini Live of Ithaca" : "Fictional GPT-Live of Ithaca";
  return { ...fake.provider, ...SPEECH[id], id, disclosure: { ...fake.provider.disclosure, voiceService },
    open: async (scope, options) => { const session = await fake.provider.open(scope, options); opened[id].push(fake.sessions.at(-1)!); return session; } };
}
const counts = () => ({ gemini: opened["gemini-live"].length, gpt: opened["gpt-live"].length });

/** Odysseus personas, as `_voice/personas/<id>.md`. */
const PERSONAS = {
  "ithaca-steward": { name: "Ithaca steward", voices: { "gemini-live": "Puck", "gpt-live": "cedar" }, text: "Calm, brief, plain words." },
  // No GPT-Live voice: S3 on GPT-Live.
  "harbour-storyteller": { name: "Harbour storyteller", voices: { "gemini-live": "Puck" }, text: "Slow and warm, with the sea in it." },
  // Orion is no longer offered by Gemini Live: S3b.
  "palace-herald": { name: "Palace herald", voices: { "gemini-live": "Orion", "gpt-live": "cedar" }, text: "Loud and clear, for the great hall." },
  // 1,709 bytes: over GPT-Live's 1,500, under Gemini Live's 2,000 (S3c).
  "long-bard": { name: "Long-winded bard", voices: { "gemini-live": "Puck", "gpt-live": "cedar" }, text: "Sing of the wrath. ".repeat(90) },
} as const;
type PersonaId = keyof typeof PERSONAS;

let fixture = "", brain = "", assets = "", origin = "", port = 0;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let owner = "";
/** Every `/api/settings/voice` write, in order, with its body. */
const writes: Array<{ status: number; body: Record<string, unknown> }> = [];

async function start(ids: Id[], hostDefault?: Id) {
  app = await hook.phase("host-start", () => createApp({
    config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(fixture, "ui.db"),
      AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1",
      HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([makeFakeBackend({ id: "start-fixture" })], "start-fixture"),
    staticRoot: assets, observability: createRecordingObservability(),
    conversationProviders: ids.map(double),
    ...(hostDefault ? { defaultConversationProviderId: hostDefault } : {}),
  }));
  const current = app;
  const handle = async (request: Request, bun: unknown) => {
    const url = new URL(request.url);
    const body = url.pathname === "/api/settings/voice" && request.method === "PUT" ? await request.clone().json().catch(() => ({})) as Record<string, unknown> : null;
    const response = await current.fetch(request, bun as never);
    if (body) writes.push({ status: response?.status ?? 0, body });
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
  fixture = await mkdtemp(resolve(tmpdir(), "odysseus-start-card-"));
  brain = resolve(fixture, "brain");
  await mkdir(resolve(brain, "notes"), { recursive: true });
  await writeFile(resolve(brain, "notes", "ithaca.md"), "# Ithaca\n\nOdysseus is expected home on 2026-07-12.\n");
  assets = resolve(fixture, "assets");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const r=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!r.success){console.error(r.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/start-card-client.tsx"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await hook.child("client-build", bundle);
  if (code !== 0) throw new Error(`Start card client build failed (${code}): ${out}\n${err}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Odysseus Start card</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}body{background:var(--bk-color-canvas);color:var(--bk-color-ink)}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  await start(["gemini-live", "gpt-live"]);
  const principal = createPrincipal(app!.db, { authMethod: "password", label: "Penelope's phone", ttlSeconds: 3600 });
  owner = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!.slice("brain_ui_session=".length);
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }));
}, 240_000);

afterAll(() => hook.phase("cleanup", async () => {
  await closeAll();
  await browser?.close();
  server?.stop(true);
  await app?.close();
  if (fixture) await rm(fixture, { recursive: true, force: true });
}));

/* ── The owner's other device, through the real routes ─────────────────── */

const headers = () => ({ cookie: `brain_ui_session=${owner}`, origin, "content-type": "application/json" });
type VoiceSettings = { defaultProvider: string | null; revision: number; persona: { value: string; revision: number } };
const settings = async () => await (await fetch(`${origin}/api/settings/voice`, { headers: headers() })).json() as VoiceSettings;
async function put(body: Record<string, unknown>) {
  const response = await fetch(`${origin}/api/settings/voice`, { method: "PUT", headers: headers(), body: JSON.stringify(body) });
  expect(response.status, "the other device saved").toBe(200);
}
/** Writes exactly these persona files, then saves the selection and the live default. */
async function brainWith(personas: PersonaId[], selected: PersonaId | "standard", service: Id | null) {
  const dir = resolve(brain, "_voice/personas");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const id of personas) {
    const p = PERSONAS[id];
    await writeFile(resolve(dir, `${id}.md`), `---\nschema: 1\nname: "${p.name}"\nvoices:\n${Object.entries(p.voices).map(([k, v]) => `  ${k}: "${v}"`).join("\n")}\n---\n${p.text}\n`);
  }
  const current = await settings();
  await put({ persona: { value: selected, revision: current.persona.revision } });
  const now = await settings();
  if (now.defaultProvider !== service) await put({ defaultProvider: service, revision: now.revision });
}
const revisionOf = async (id: string) =>
  ((await (await fetch(`${origin}/api/voice/personas`, { headers: headers() })).json()) as { personas: Array<{ id: string; revision: string }> }).personas.find((p) => p.id === id)!.revision;

/* ── The page ─────────────────────────────────────────────────────────── */

const contexts: BrowserContext[] = [];
async function open(width: number, height: number): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width, height }, hasTouch: width < 900 });
  contexts.push(context);
  await context.addCookies([{ name: "brain_ui_session", value: owner, url: `http://127.0.0.1:${port}` }]);
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  // Count every microphone request and every frame the page sends, from its first script on.
  await context.addInitScript(() => {
    const scope = window as unknown as { __gum: number; __sent: Array<Record<string, unknown>> };
    scope.__gum = 0; scope.__sent = [];
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => { scope.__gum++; return original(constraints); };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") try { scope.__sent.push(JSON.parse(data) as Record<string, unknown>); } catch { /* not a frame */ }
      return send.call(this, data);
    };
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction("window.__start?.connected()");
  return page;
}
async function closeAll() { for (const context of contexts.splice(0)) await context.close(); }

type StartState = { active: boolean; disclosureOpen: boolean; disclosed: string | null; opened: string | null; source: string | null; capture: string; micOn: boolean; persona: string | null;
  personaChoice: { id: string; revision: string; voice?: string } | null };
const state = (page: Page) => page.evaluate(() => (window as unknown as { __start: { state(): StartState } }).__start.state());
const gum = (page: Page) => page.evaluate(() => (window as unknown as { __gum: number }).__gum);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Array<Record<string, unknown>> }).__sent);
/** Frames that would start a provider, a microphone stream or a history read for one. */
const starting = async (page: Page) => (await sent(page)).filter((frame) => String(frame.type).startsWith("conversation_")).map((frame) => frame.type);
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

/** Enter live conversation: the Start card, before any Start, with its persona list read. */
async function enter(page: Page, personas: number) {
  await page.waitForFunction("window.__start.ready()");
  await page.evaluate(() => (window as unknown as { __start: { enter(): void } }).__start.enter());
  const card = page.locator("[data-start-card]");
  await card.waitFor();
  await page.waitForFunction((n) => document.querySelectorAll("[data-start-card] [role=radio]").length === n, personas);
  return card;
}
const line = (page: Page) => page.locator("[data-start-card] .bk-voice-card-line").textContent();
const notice = (page: Page) => page.locator("[data-start-card] .bk-voice-card-notice").textContent();
const startButton = (page: Page) => page.locator("[data-start-card] .bk-voice-start");
/** Nothing has started: no frame toward a provider, no microphone, no double opened. */
async function nothingStarted(page: Page, before: ReturnType<typeof counts>, what: string) {
  expect(await starting(page), `${what}: NO_CONVERSATION_FRAME_BEFORE_START`).toEqual([]);
  expect(await gum(page), `${what}: NO_MICROPHONE_BEFORE_START`).toBe(0);
  expect(counts(), `${what}: NO_PROVIDER_BEFORE_START`).toEqual(before);
  const s = await state(page);
  expect(s.micOn || s.capture !== "idle", `${what}: NO_CAPTURE_BEFORE_START`).toBe(false);
}
/** A blocked Start does nothing when pressed. */
async function startRefused(page: Page, before: ReturnType<typeof counts>, what: string) {
  expect(await startButton(page).getAttribute("aria-disabled"), `${what}: START_BLOCKED`).toBe("true");
  // aria-disabled keeps it focusable; a forced press still reaches the handler.
  await startButton(page).click({ force: true });
  await page.waitForTimeout(150);
  await nothingStarted(page, before, what);
}
async function startAndWait(page: Page) {
  await startButton(page).click();
  await page.waitForFunction(() => (window as unknown as { __start: { state(): StartState } }).__start.state().opened !== null);
  const frames = (await sent(page)).filter((frame) => frame.type === "conversation_start");
  expect(frames, "one Start, one conversation_start").toHaveLength(1);
  return frames[0]! as { providerId?: string; disclosed: { providerId: string }; personaRef?: { id: string; revision: string; voice?: string } };
}
async function leave(page: Page) {
  await page.evaluate(() => (window as unknown as { __start: { leave(): void } }).__start.leave());
  await page.waitForFunction(() => !(window as unknown as { __start: { state(): StartState } }).__start.state().active);
}
/** The card sits wholly inside the viewport, with no horizontal page scroll, and Start and Cancel in reach. */
async function fits(page: Page, width: number, height: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `no horizontal scroll at ${width}px`).toBeLessThanOrEqual(width);
  for (const selector of ["[data-start-card]", "[data-start-card] .bk-voice-start", "[data-start-card] [aria-label=Cancel]"]) {
    const box = (await page.locator(selector).boundingBox())!;
    expect(box.x, `${selector} inside the left edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${selector} inside the right edge`).toBeLessThanOrEqual(width);
    expect(box.y, `${selector} inside the top edge`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${selector} fits ${width}×${height}`).toBeLessThanOrEqual(height);
  }
  // Whatever "What's shared" opened can be scrolled to inside the card.
  const last = page.locator("[data-start-card] .bk-voice-shared-list li").last();
  if (await last.count()) {
    await last.scrollIntoViewIfNeeded();
    const box = (await last.boundingBox())!;
    expect(box.y + box.height, "the last shared line is reachable").toBeLessThanOrEqual(height);
    await page.locator("[data-start-card]").evaluate((node) => { node.scrollTop = 0; });
  }
}

describe.skipIf(!executablePath)("the Start card against mounted routes and two live-service doubles", () => {
  for (const [width, height] of SIZES) test(`${width}px: three personas and the Service row fit; a pick is saved (V2), Change is not; nothing starts before Start; Start sends what the card shows`, async () => {
    await restart(["gemini-live", "gpt-live"]);
    await brainWith(["ithaca-steward", "harbour-storyteller"], "ithaca-steward", "gemini-live");
    const page = await open(width, height);
    const before = counts();
    const card = await enter(page, 3);
    await fits(page, width, height);
    await shot(page, `start-s2-${width}`);
    // S2+: several services, the saved one named, the last persona preselected.
    expect(await line(page)).toBe("Gemini Live hears you and reads this chat.");
    expect(await card.getByRole("button", { name: "Change service, now Gemini Live" }).count()).toBe(1);
    expect(await card.getByRole("radio", { name: /Ithaca steward/ }).getAttribute("aria-checked"), "the last pick is preselected").toBe("true");
    expect(await card.getByRole("radio", { name: /Ithaca steward/ }).textContent()).toContain("voice Puck");
    expect(await card.getByRole("radio", { name: /Standard/ }).textContent()).toContain("voice Kore");
    expect(await page.evaluate(() => document.activeElement?.classList.contains("bk-voice-start")), "the card takes focus on its Start").toBe(true);
    // "What's shared" keeps everything the disclosure sheet said.
    await card.getByRole("button", { name: /What’s shared/ }).click();
    const shared = await card.locator(".bk-voice-shared-list").textContent();
    for (const text of ["Fictional Gemini Live of Ithaca", "Host relay: ", "Independently selected agent backend:", "Starting voice sends bounded prior chat text", "Spoken refusal is unavailable"])
      expect(shared, `shared: ${text}`).toContain(text);
    await nothingStarted(page, before, "S2");

    // Change: this conversation only, never saved.
    const writesBefore = writes.length;
    await card.getByRole("button", { name: "Change service, now Gemini Live" }).click();
    await page.waitForLoadState("networkidle");
    await nothingStarted(page, before, "after Change");
    expect(await line(page)).toBe("GPT-Live hears you and reads this chat.");
    expect(await card.locator(".bk-voice-shared-list").textContent(), "the disclosure follows the Change").toContain("Fictional GPT-Live of Ithaca");
    await page.waitForLoadState("networkidle");
    expect(writes.slice(writesBefore).filter((w) => "defaultProvider" in w.body), "CHANGE_IS_NOT_SAVED").toEqual([]);

    // V2: picking a persona also saves it as the default, and S3 names the default voice.
    await card.getByRole("radio", { name: /Harbour storyteller/ }).click();
    await page.waitForLoadState("networkidle");
    await nothingStarted(page, before, "after a persona pick");
    for (let waited = 0; (await settings()).persona.value !== "harbour-storyteller" && waited < 5_000; waited += 50) await Bun.sleep(50);
    expect((await settings()).persona.value, "V2_PICK_IS_SAVED").toBe("harbour-storyteller");
    await page.waitForFunction(() => (window as unknown as { __start: { state(): StartState } }).__start.state().persona === "harbour-storyteller");
    expect(writes.slice(writesBefore).map((w) => Object.keys(w.body)), "only the persona was written").toEqual([["persona"]]);
    expect(await notice(page)).toBe("Harbour storyteller has no GPT-Live voice. The default voice (marin) is used this time.");
    expect(await card.getByRole("radio", { name: /Harbour storyteller/ }).textContent()).toContain("no GPT-Live voice set");
    expect(await startButton(page).getAttribute("aria-disabled"), "S3 keeps Start").toBe(null);
    await fits(page, width, height);
    await shot(page, `start-s3-${width}`);

    // Start sends exactly what the card discloses.
    const echo = await startAndWait(page);
    expect(echo.providerId, "ECHO_SERVICE").toBe("gpt-live");
    expect(echo.disclosed.providerId).toBe("gpt-live");
    expect(echo.personaRef, "ECHO_PERSONA").toEqual({ id: "harbour-storyteller", revision: await revisionOf("harbour-storyteller") });
    expect(counts(), "the Change opened GPT-Live").toEqual({ gemini: before.gemini, gpt: before.gpt + 1 });
    expect(opened["gpt-live"].at(-1)!.options?.persona, "ECHO_DEFAULT_VOICE: no voice option, so the service default (marin)").toEqual({ instructions: PERSONAS["harbour-storyteller"].text });
    expect((await state(page)).source).toBe("change");
    expect((await settings()).defaultProvider, "CHANGE_IS_NOT_SAVED after Start").toBe("gemini-live");
    await leave(page);
  }, 120_000);

  for (const [width, height] of SIZES) test(`${width}px: S3b a saved voice no longer offered blocks Start until the default voice is chosen for this time`, async () => {
    await restart(["gemini-live"]);
    await brainWith(["palace-herald", "ithaca-steward"], "palace-herald", null);
    const page = await open(width, height);
    const before = counts();
    const card = await enter(page, 3);
    expect(await card.getByRole("button", { name: /Change service/ }).count(), "one service: no Change").toBe(0);
    expect(await notice(page)).toBe("Palace herald’s saved voice, Orion, is no longer offered by Gemini Live. Use the default voice this time, or edit the persona.");
    await fits(page, width, height);
    await shot(page, `start-s3b-${width}`);
    await startRefused(page, before, "S3b");
    await card.getByRole("button", { name: "Use the default voice this time" }).click();
    expect(await notice(page)).toBe("Palace herald’s saved voice, Orion, isn’t offered by Gemini Live. The default voice (Kore) is used this time.");
    expect(await card.getByRole("radio", { name: /Palace herald/ }).textContent()).toContain("default voice Kore this time");
    await nothingStarted(page, before, "after choosing the default voice");
    const echo = await startAndWait(page);
    expect(echo.personaRef, "ECHO_DEFAULT_VOICE_CHOICE").toEqual({ id: "palace-herald", revision: await revisionOf("palace-herald"), voice: "default" });
    expect(opened["gemini-live"].at(-1)!.options?.persona, "the service's default voice, not a substitute").toEqual({ instructions: PERSONAS["palace-herald"].text });
    expect((await settings()).persona.value, "the one-time voice choice saves nothing").toBe("palace-herald");
    await leave(page);
  }, 120_000);

  for (const [width, height] of SIZES) test(`${width}px: S3c instructions over the service's cap block Start; Change to a service that takes them`, async () => {
    await restart(["gemini-live", "gpt-live"]);
    await brainWith(["long-bard", "ithaca-steward"], "long-bard", "gpt-live");
    const page = await open(width, height);
    const before = counts();
    const card = await enter(page, 3);
    expect(await notice(page)).toBe("Long-winded bard’s instructions are 1,709 bytes; GPT-Live takes 1,500. Shorten them or change the service.");
    expect(await card.getByRole("button", { name: "Edit persona" }).count()).toBe(1);
    await fits(page, width, height);
    await shot(page, `start-s3c-${width}`);
    await startRefused(page, before, "S3c");
    await card.getByRole("button", { name: "Change service, now GPT-Live" }).click();
    expect(await card.locator(".bk-voice-card-notice").count(), "Gemini Live takes them").toBe(0);
    const echo = await startAndWait(page);
    expect(echo.providerId).toBe("gemini-live");
    expect(echo.personaRef).toEqual({ id: "long-bard", revision: await revisionOf("long-bard") });
    expect(opened["gemini-live"].at(-1)!.options?.persona).toEqual({ voice: "Puck", instructions: PERSONAS["long-bard"].text.trim() });
    expect(counts()).toEqual({ gemini: before.gemini + 1, gpt: before.gpt });
    expect((await settings()).defaultProvider, "CHANGE_IS_NOT_SAVED").toBe("gpt-live");
    await leave(page);
  }, 120_000);

  for (const [width, height] of SIZES) test(`${width}px: S3d the saved service is unavailable; an explicit pick is required and never substituted`, async () => {
    await restart(["gemini-live", "gpt-live"]);
    await brainWith(["ithaca-steward"], "ithaca-steward", "gpt-live");
    await restart(["gemini-live"], "gemini-live");
    const page = await open(width, height);
    const before = counts();
    const card = await enter(page, 2);
    expect(await line(page)).toBe("A live service hears you and reads this chat.");
    expect(await notice(page)).toBe("Your saved service, GPT-Live, isn’t available here. Choose a service to start.");
    expect(await card.locator(".bk-voice-service-name").textContent(), "S3D_NO_SUBSTITUTE").toBe("Choose a service");
    await fits(page, width, height);
    // The required-service row keeps its key and its Choose on one line each, even at 320px.
    for (const selector of [".bk-voice-service-key", ".bk-voice-service .bk-voice-link"])
      expect(await card.locator(selector).evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size; }), `${selector} stays on one line`).toBe(1);
    await shot(page, `start-s3d-${width}`);
    await startRefused(page, before, "S3d");
    await card.getByRole("button", { name: "Choose a service" }).click();
    expect(await line(page)).toBe("Gemini Live hears you and reads this chat.");
    await nothingStarted(page, before, "after the pick");
    const echo = await startAndWait(page);
    expect(echo.providerId).toBe("gemini-live");
    expect(counts(), "S3D_PICK_OPENS").toEqual({ gemini: before.gemini + 1, gpt: before.gpt });
    expect((await settings()).defaultProvider, "the unavailable saved default is kept").toBe("gpt-live");
    await leave(page);
  }, 120_000);

  for (const [width, height] of SIZES) test(`${width}px: a persona edited before Start is refused as a VoiceNotice; Start again reopens the card`, async () => {
    await restart(["gemini-live"]);
    await brainWith(["ithaca-steward"], "ithaca-steward", null);
    const page = await open(width, height);
    const before = counts();
    await enter(page, 2);
    // Another device edits the persona after the card read it.
    const p = PERSONAS["ithaca-steward"];
    await writeFile(resolve(brain, "_voice/personas/ithaca-steward.md"), `---\nschema: 1\nname: "${p.name}"\nvoices:\n  gemini-live: "Kore"\n---\nSlower now.\n`);
    await startButton(page).click();
    const stopped = page.locator("[data-conversation-field] .bk-voice-notice, [data-conversation-field] [role=alert], [data-conversation-field]").getByText("Live conversation stopped");
    await stopped.waitFor();
    expect(await page.locator("[data-conversation-field]").textContent()).toContain("The persona changed. Review it and select Start again.");
    expect(counts(), "REFUSED_START_OPENS_NOTHING").toEqual(before);
    await shot(page, `start-refused-${width}`);
    await page.getByRole("button", { name: "Start again" }).click();
    const card = page.locator("[data-start-card]");
    await card.waitFor();
    await page.waitForFunction(() => document.querySelector("[data-start-card] [role=radio][aria-checked=true]")?.textContent?.includes("voice Kore"));
    await startButton(page).click();
    await page.waitForFunction(() => (window as unknown as { __start: { state(): StartState } }).__start.state().opened !== null);
    expect(opened["gemini-live"].at(-1)!.options?.persona, "the edited persona, as the card showed it").toEqual({ voice: "Kore", instructions: "Slower now." });
    await leave(page);
  }, 120_000);
});
