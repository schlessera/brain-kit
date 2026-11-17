import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";
import { runtimePackageBuild } from "./fixtures/runtime-package-build";
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";

// The passkey login screen in real Chrome against real ui-server routes
// (#2555). Conditional UI attaches to the password field's `webauthn`
// autofill. On a passkey-only deployment there is no such field, so the
// screen must not spend a login-options token (10 per IP per minute) or leave
// a challenge behind, while the explicit "Sign in with a passkey" button still
// signs in. Beside a password field, conditional UI still starts once.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Passkey login runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING passkey login runtime proof: no Chrome; the passkey login screen is unverified in a browser locally.");

const repo = resolve(import.meta.dir, "../../..");
const PASSWORD = "the bow only Odysseus can string";
let browser: Browser | undefined;
let scratch = "";
let brain = "";
let assets = "";
let passwordHash = "";
let port = 0;
type Host = { app: Awaited<ReturnType<typeof createApp>>; server: ReturnType<typeof Bun.serve> };
let host: Host | undefined;

const backend: AgentBackend = {
  id: "local-scripted", capabilities: { resume: true, permissions: false, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
  listProfiles: () => [{ id: "local-scripted", label: "Local fixture" }],
  listSessions: async () => [],
  getHistory: async () => [],
  async startTurn() {},
};

/** One host on the shared database and port; `allowPassword` keeps password login beside a passkey. */
async function startHost(allowPassword: boolean): Promise<Host> {
  const app = await createApp({
    config: resolveServerConfig({
      BRAIN_PATH: brain, DB_PATH: resolve(scratch, "ithaca.db"), AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: passwordHash,
      COOKIE_SECRET: "odysseus-passkey-login-cookie-secret-0123456789", HOST: "127.0.0.1", NODE_ENV: "test",
      BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0", ...(allowPassword ? { BRAIN_UI_ALLOW_PASSWORD: "1" } : {}),
    }),
    staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), turnTimeoutMs: 60_000,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, websocket: app.websocket });
  port = server.port!;
  return { app, server };
}
async function stopHost(h: Host | undefined) {
  if (!h) return;
  h.server.stop(true);
  h.app.cancelActiveTurns();
  await h.app.close();
}
// `localhost`, not 127.0.0.1: an IP address is not a valid WebAuthn RP ID.
const origin = () => `http://localhost:${port}`;

const hook = runtimeHookPhases("passkey-login-runtime");

beforeAll(async () => {
  if (!executablePath) return;
  // The browser bundle resolves the workspace packages' built output.
  const [out, err, code] = await runtimePackageBuild(repo, ["ui-react", "ui-server", "core"], hook);
  if (code !== 0) throw new Error(`Passkey login fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-passkey-login-"));
  brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  assets = resolve(scratch, "client");
  await mkdir(assets);
  const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, "fixtures/passkey-login-client.ts")], target: "browser", outdir: assets, naming: "client.js" });
  if (!result.success) throw new Error(`Passkey login client build failed: ${result.logs.join("\n")}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  passwordHash = await Bun.password.hash(PASSWORD);
  host = await startHost(false);
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await stopHost(host);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** A page with a CDP virtual authenticator that answers with user verification, and a log of what it asked. */
async function passkeyPage(context: BrowserContext): Promise<{ page: Page; cdp: CDPSession; options: string[]; warnings: string[] }> {
  // Record each credentials.get mediation, so "conditional UI started" is the
  // browser's own fact, and each conditional-mediation probe: the screen runs
  // that probe in the same tick that draws its passkey button, just before it
  // would ask for login options.
  await context.addInitScript(() => {
    const seen = window as unknown as { __mediations: string[]; __probes: number };
    seen.__mediations = []; seen.__probes = 0;
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (request?: CredentialRequestOptions) => {
      seen.__mediations.push(String(request?.mediation ?? "optional"));
      return get(request);
    };
    const probe = PublicKeyCredential.isConditionalMediationAvailable.bind(PublicKeyCredential);
    PublicKeyCredential.isConditionalMediationAvailable = () => { seen.__probes++; return probe(); };
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const options: string[] = [], warnings: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/auth/passkey/login-options") options.push(request.method()); });
  page.on("console", (message) => { if (message.type() === "warning" && message.text().startsWith("[passkeys]")) warnings.push(message.text()); });
  return { page, cdp, options, warnings };
}

const methods = (page: Page) => page.evaluate(async () => (await fetch("/api/auth/methods", { cache: "no-store" })).json());
/** Waits until the login screen has the methods answer and has drawn its passkey button. */
const loginScreenSettled = (page: Page) => page.getByRole("button", { name: "Sign in with a passkey" }).waitFor({ state: "visible", timeout: 15_000 });

test.skipIf(!executablePath)("a passkey-only screen asks for no login options, and its passkey button still signs in", async () => {
  const context = await browser!.newContext();
  try {
    const { page, options, warnings } = await passkeyPage(context);
    await page.goto(origin());
    // No credential yet: the password signs in, and the passkey is registered.
    await page.getByPlaceholder("Password").waitFor({ timeout: 15_000 });
    await page.evaluate((password) => (window as unknown as { __passkey: { register(p: string): Promise<void> } }).__passkey.register(password), PASSWORD);
    expect(await methods(page), "one passkey and no password override: passkey-only").toEqual({ password: false, passkey: true });

    await context.clearCookies();
    options.length = 0;
    await page.reload();
    await loginScreenSettled(page);
    expect(await page.getByPlaceholder("Password").count(), "no password field, so no webauthn autofill input").toBe(0);
    // The causal barrier: the screen decides in the same tick that draws the
    // button, so a conditional ceremony would already have probed. Then the
    // page's network goes idle, so a login-options request would have left.
    expect(await page.evaluate(() => (window as unknown as { __probes: number }).__probes), "conditional UI never probed").toBe(0);
    await page.waitForLoadState("networkidle");
    expect(options, "PASSKEY_ONLY_NO_LOGIN_OPTIONS").toEqual([]);
    expect(warnings, "no [passkeys] warning").toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __mediations: string[] }).__mediations)).toEqual([]);

    // The explicit button: one login-options request, then a signed-in app.
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.locator("#signed-in").waitFor({ timeout: 15_000 });
    expect(options, "the button asked once").toEqual(["POST"]);
    expect(warnings).toEqual([]);
  } finally { await context.close(); }
}, 90_000);

test.skipIf(!executablePath)("beside a password field, conditional UI starts once and offers the passkey in the field's autofill", async () => {
  await stopHost(host);
  host = await startHost(true);
  const context = await browser!.newContext();
  try {
    const { page, options, warnings } = await passkeyPage(context);
    await page.goto(origin());
    expect(await methods(page)).toEqual({ password: true, passkey: true });
    await loginScreenSettled(page);
    expect(await page.getByPlaceholder("Password").getAttribute("autocomplete")).toBe("current-password webauthn");
    expect(await page.evaluate(() => (window as unknown as { __probes: number }).__probes), "positive control for the probe barrier (startAuthentication probes again)").toBeGreaterThan(0);
    await page.waitForFunction(() => (window as unknown as { __mediations: string[] }).__mediations.length > 0, undefined, { timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __mediations: string[] }).__mediations), "the browser was asked for a conditional (autofill) passkey").toEqual(["conditional"]);
    await page.waitForLoadState("networkidle");
    expect(options, "exactly one login-options request on load").toEqual(["POST"]);
    expect(warnings).toEqual([]);
  } finally { await context.close(); }
}, 90_000);
