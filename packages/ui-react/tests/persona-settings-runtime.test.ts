import { runtimePackageBuild } from "./fixtures/runtime-package-build";
// #3617: live-conversation personas in Settings › Voice, in real Chrome against
// a real password-mode server and a real brain directory. A keyless
// live-conversation double records what each Start opened, so the server,
// not this page, proves which persona reached the provider. Every pane state
// is checked at 320px and 1280px. Nothing leaves loopback.
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import { createPrincipal } from "../../ui-server/src/db/principals.js";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.ts";
import { fakeLiveProvider } from "../../ui-server/tests/helpers/live-conversation.ts";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Persona settings runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING persona settings runtime proof: no Chrome; Settings › Voice personas are unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
const SECRET = "persona-settings-runtime-secret-0123456789";
const SHOTS = process.env.BRAIN_PERSONA_SCREENSHOTS;
const hook = runtimeHookPhases("persona-settings-runtime");
const live = fakeLiveProvider();
Object.assign(live.provider, { id: "ithaca-live", voices: [{ id: "Kore", label: "Kore" }, { id: "Calypso", label: "Calypso" }], defaultVoice: "Kore", personaInstructionBytes: 2_000 });

let fixture = "", brain = "", assets = "", origin = "", port = 0;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
const cookies = { owner: "", reader: "" };
const personaFile = (id: string) => resolve(brain, "_voice/personas", `${id}.md`);

beforeAll(async () => {
  if (!executablePath) return;
  await runtimePackageBuild(repo, ["ui-react", "ui-server", "core"], hook);
  fixture = await mkdtemp(resolve(tmpdir(), "odysseus-personas-"));
  brain = resolve(fixture, "brain");
  await mkdir(resolve(brain, "notes"), { recursive: true });
  await writeFile(resolve(brain, "notes", "ithaca.md"), "# Ithaca\n\nOdysseus is expected home on 2026-07-12.\n");
  assets = resolve(fixture, "assets");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const r=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!r.success){console.error(r.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/persona-settings-client.tsx"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await hook.child("client-build", bundle);
  if (code !== 0) throw new Error(`Persona settings client build failed (${code}): ${out}\n${err}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Odysseus personas</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}body{background:var(--bk-color-canvas);color:var(--bk-color-ink)}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  app = await hook.phase("host-start", () => createApp({
    config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(fixture, "ui.db"),
      AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1",
      HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([makeFakeBackend({ id: "persona-fixture" })], "persona-fixture"),
    staticRoot: assets, observability: createRecordingObservability(), conversationProvider: live.provider,
  }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, bun) => app!.fetch(request, bun as never), websocket: app.websocket });
  port = server.port!;
  origin = `http://127.0.0.1:${port}`;
  const owner = createPrincipal(app.db, { authMethod: "password", label: "Penelope's phone", ttlSeconds: 3600 });
  const reader = createPrincipal(app.db, { authMethod: "delegated", createdBy: owner.id, label: "Telemachus agent", ttlSeconds: 3600 });
  for (const [who, principal] of [["owner", owner], ["reader", reader]] as const) {
    const signed = await generateSignedCookie("brain_ui_session", principal.id, SECRET);
    cookies[who] = signed.split(";")[0]!.slice("brain_ui_session=".length);
  }
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }));
}, 240_000);

afterAll(() => hook.phase("cleanup", async () => {
  await browser?.close();
  server?.stop(true);
  await app?.close();
  if (fixture) await rm(fixture, { recursive: true, force: true });
}));

type Hooks = { __personas: { ready(): boolean; openSettings(): void; closeSettings(): void; start(): void; leave(): void; notice(): string;
  livePersona(): { selected: string; personaRef: { id: string; revision: string } } | null } };
const contexts: BrowserContext[] = [];
async function open(width: number, who: "owner" | "reader" = "owner"): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width, height: width < 900 ? 720 : 860 }, hasTouch: width < 900 });
  contexts.push(context);
  await context.addCookies([{ name: "brain_ui_session", value: cookies[who], url: origin }]);
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  if (who === "owner") await page.waitForFunction(() => (window as unknown as Hooks).__personas?.ready());
  else await page.waitForFunction(() => !!(window as unknown as Hooks).__personas);
  return page;
}
async function closeAll() { for (const context of contexts.splice(0)) await context.close(); }
/** Opens Settings › Voice and waits for the Persona group's own read to answer. */
async function settings(page: Page) {
  await page.evaluate(() => (window as unknown as Hooks).__personas.openSettings());
  const pane = page.locator("[data-persona-settings]");
  await pane.waitFor();
  await page.waitForFunction(() => { const pane = document.querySelector("[data-persona-settings]"); return pane && !pane.getAttribute("aria-busy") && pane.querySelector("[data-persona-row], [data-persona-owner]"); });
  return pane;
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}
/** No horizontal page scroll, and every target in the selector at least 44px tall. */
async function fits(page: Page, width: number, selector: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `no horizontal scroll at ${width}px`).toBeLessThanOrEqual(width);
  const heights = await page.locator(selector).evaluateAll((nodes) => nodes.filter((n) => (n as HTMLElement).offsetParent !== null).map((node) => Math.round(node.getBoundingClientRect().height)));
  for (const height of heights) expect(height, `${selector} at ${width}px`).toBeGreaterThanOrEqual(44);
}
const owner = { cookie: () => `brain_ui_session=${cookies.owner}` };
async function api(method: string, path: string, body?: unknown) {
  return fetch(`${origin}/api${path}`, { method, headers: { cookie: owner.cookie(), origin, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function reset() {
  const list = await (await api("GET", "/voice/personas")).json() as { personas: Array<{ id: string; revision: string; builtIn?: true }> };
  for (const persona of list.personas) if (!persona.builtIn) await api("DELETE", `/voice/personas/${persona.id}?baseRevision=${persona.revision}`);
}

describe.skipIf(!executablePath)("Settings › Voice personas, against mounted routes and a real brain", () => {
  test("320px: create with validation, select, reload, a conflicting edit, Start with the persona, delete", async () => {
    await reset();
    const page = await open(320);
    try {
      let pane = await settings(page);
      expect(await pane.locator("[data-persona-empty]").textContent()).toBe("Only Standard so far. Personas you add appear here.");
      expect(await pane.getByRole("radio", { name: /Standard/ }).isChecked()).toBe(true);
      await fits(page, 320, "[data-persona-row]");
      await shot(page, "persona-empty-320");

      await pane.getByRole("button", { name: "+ New persona" }).click();
      const editor = pane.locator('[data-persona-editor="new"]');
      await editor.waitFor();
      await editor.getByRole("button", { name: "Save" }).click();
      expect(await pane.locator("[data-persona-errors]").textContent()).toContain("Give the persona a name (up to 40 characters).");
      await editor.locator("[data-persona-instructions]").fill("é".repeat(1_001));
      expect(await editor.locator("[data-persona-count]").textContent()).toBe("2,002 / 2,000 bytes for ithaca-live (too long)");
      await editor.locator("[data-persona-name]").fill("Ithaca steward");
      await editor.locator('[data-persona-voice="ithaca-live"]').selectOption("Calypso");
      await editor.locator("[data-persona-instructions]").fill("Calm, brief, plain words. <b>Never markup.</b>");
      expect(await editor.locator("b").count(), "INSTRUCTIONS_STAY_PLAIN_TEXT").toBe(0);
      await fits(page, 320, "[data-persona-editor] button");
      await shot(page, "persona-editor-320");
      await editor.getByRole("button", { name: "Save" }).click();
      await pane.locator('[data-persona-row="ithaca-steward"]').waitFor();
      expect(readFileSync(personaFile("ithaca-steward"), "utf8"), "PERSONA_SAVED_AS_MARKDOWN").toBe('---\nschema: 1\nname: "Ithaca steward"\nvoices:\n  ithaca-live: "Calypso"\n---\nCalm, brief, plain words. <b>Never markup.</b>\n');
      expect(await pane.locator('[data-persona-row="ithaca-steward"]').textContent()).toContain("Calypso · 46 bytes");

      await pane.getByRole("radio", { name: /Ithaca steward/ }).check();
      await page.waitForFunction(() => (window as unknown as Hooks).__personas.livePersona()?.selected === "ithaca-steward");
      await page.reload();
      await page.waitForFunction(() => (window as unknown as Hooks).__personas?.ready());
      pane = await settings(page);
      expect(await pane.getByRole("radio", { name: /Ithaca steward/ }).isChecked(), "SELECTION_SURVIVES_RELOAD").toBe(true);

      // Another device edits the file while this one has the editor open.
      await pane.getByRole("button", { name: "More for Ithaca steward" }).click();
      await page.getByRole("menuitem", { name: "Edit" }).click();
      const edit = pane.locator('[data-persona-editor="ithaca-steward"]');
      await edit.waitFor();
      writeFileSync(personaFile("ithaca-steward"), '---\nschema: 1\nname: "Ithaca steward"\nvoices:\n  ithaca-live: "Calypso"\n---\nSlow and kind.\n');
      await edit.locator("[data-persona-instructions]").fill("Mine: brisk.");
      await edit.getByRole("button", { name: "Save" }).click();
      await pane.locator("[data-persona-conflict]").waitFor();
      expect(await edit.locator("[data-persona-instructions]").inputValue(), "CONFLICT_KEEPS_USER_TEXT").toBe("Mine: brisk.");
      await shot(page, "persona-conflict-320");
      await pane.getByRole("button", { name: "Show the newer version" }).click();
      expect(await edit.locator("[data-persona-instructions]").inputValue()).toBe("Slow and kind.");
      await edit.getByRole("button", { name: "Cancel" }).click();
      await pane.locator('[data-persona-row="ithaca-steward"]').waitFor();
      await page.evaluate(() => (window as unknown as Hooks).__personas.closeSettings());

      // The file changed outside this page, so its disclosed revision is out of
      // date: Start is refused before anything opens, with the current persona pushed first.
      const opened = live.sessions.length;
      const stale = await page.evaluate(() => (window as unknown as Hooks).__personas.livePersona()!.personaRef.revision);
      await page.evaluate(() => (window as unknown as Hooks).__personas.start());
      await page.waitForFunction(() => (window as unknown as Hooks).__personas.notice().startsWith("The persona changed."));
      expect(live.sessions.length, "OUTDATED_PERSONA_OPENS_NOTHING").toBe(opened);
      expect(await page.evaluate(() => (window as unknown as Hooks).__personas.livePersona()!.personaRef.revision)).not.toBe(stale);
      // Start again uses the persona the server resolves now; the provider double records it.
      await page.evaluate(() => (window as unknown as Hooks).__personas.start());
      for (let waited = 0; live.sessions.length === opened; waited += 20) { if (waited > 10_000) throw new Error(`No provider opened: ${await page.evaluate(() => (window as unknown as Hooks).__personas.notice())}`); await Bun.sleep(20); }
      expect(live.sessions.at(-1)!.options.persona, "SELECTED_PERSONA_REACHES_PROVIDER").toEqual({ voice: "Calypso", instructions: "Slow and kind." });
      await page.evaluate(() => (window as unknown as Hooks).__personas.leave());

      pane = await settings(page);
      await pane.getByRole("button", { name: "More for Ithaca steward" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      const dialog = page.getByRole("alertdialog");
      expect(await dialog.textContent()).toContain("It's the selected persona. New conversations will use Standard.");
      await shot(page, "persona-delete-320");
      await dialog.getByRole("button", { name: "Delete" }).click();
      await pane.locator('[data-persona-row="ithaca-steward"]').waitFor({ state: "detached" });
      expect(existsSync(personaFile("ithaca-steward"))).toBe(false);
      expect(await pane.getByRole("radio", { name: /Standard/ }).isChecked(), "DELETE_SELECTED_FALLS_BACK_TO_STANDARD").toBe(true);
    } finally { await closeAll(); }
  }, 120_000);

  test("1280px: desktop Edit, selection and Start with Standard send no persona", async () => {
    await reset();
    await api("POST", "/voice/personas", { name: "Penelope", voices: {}, instructions: "Warm and patient." });
    const page = await open(1280);
    try {
      const pane = await settings(page);
      const row = pane.locator('[data-persona-row="penelope"]');
      expect(await row.textContent()).toContain("default voice · 17 bytes");
      expect(await row.getByRole("button", { name: "Edit Penelope" }).isVisible(), "desktop shows Edit").toBe(true);
      await fits(page, 1280, "[data-persona-row]");
      await shot(page, "persona-list-1280");
      await page.evaluate(() => (window as unknown as Hooks).__personas.closeSettings());
      const opened = live.sessions.length;
      await page.evaluate(() => (window as unknown as Hooks).__personas.start());
      for (let waited = 0; live.sessions.length === opened; waited += 20) { if (waited > 10_000) throw new Error("No provider opened"); await Bun.sleep(20); }
      expect("persona" in live.sessions.at(-1)!.options, "STANDARD_SENDS_NO_PERSONA").toBe(false);
      await page.evaluate(() => (window as unknown as Hooks).__personas.leave());
    } finally { await closeAll(); }
  }, 120_000);

  test("a delegated agent session sees neither personas nor their text", async () => {
    const page = await open(1280, "reader");
    try {
      const pane = await settings(page);
      expect(await pane.locator("[data-persona-owner]").textContent()).toBe("Only the owner can see and change personas.");
      expect(await pane.locator("[data-persona-row]").count()).toBe(0);
    } finally { await closeAll(); }
  }, 60_000);
});
