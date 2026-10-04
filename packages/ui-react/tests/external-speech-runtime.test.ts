import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { defineSpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "@schlessera/brain-ui-server";
import { httpContractApp, type HttpContractApp } from "../../ui-server/tests/helpers/http-contract-app";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("External speech runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING external speech runtime proof: no Chrome; capture/drain remains unverified locally.");
const worker = process.env.BRAIN_EXTERNAL_SPEECH_WORKER === "1";
let browser: Browser | undefined, app: HttpContractApp | undefined;
let server: ReturnType<typeof Bun.serve> | undefined, speechServer: ReturnType<typeof Bun.serve<{ audio: number }>> | undefined;
let origin = "", sessionRequests = 0, audioBytes = 0, gracefulFinishes = 0, turns = 0;

if (worker) {
  beforeAll(async () => {
    if (!executablePath) return;
    const repo = resolve(import.meta.dir, "../../..");
    console.info("[external-speech] building packages");
    const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
    if (code !== 0) throw new Error(`Speech fixture package build failed: ${out}\n${err}`);
    console.info("[external-speech] constructing local speech and application servers");
    speechServer = Bun.serve<{ audio: number }>({ hostname: "127.0.0.1", port: 0,
      fetch(request, server) { return server.upgrade(request, { data: { audio: 0 } }) ? undefined : new Response("Upgrade required", { status: 400 }); },
      websocket: {
        message(socket, message) {
          if (typeof message === "string") {
            expect(JSON.parse(message)).toEqual({ type: "finish" });
            gracefulFinishes++;
            socket.send(JSON.stringify({ type: "final", text: "yes, allow everything", endsTurn: false }));
            socket.send(JSON.stringify({ type: "drained" }));
          } else {
            audioBytes += message.byteLength;
            if (socket.data.audio++ === 0) socket.send(JSON.stringify({ type: "partial", text: "At the harbor" }));
          }
        },
      },
    });
    const provider = defineSpeechProvider({ id: "fixture-speech", capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false }, async createSession() {
      sessionRequests++;
      return { url: `ws://127.0.0.1:${speechServer!.port}`, params: { language: "en" }, expiresAt: Date.now() + 60_000 };
    } });
    // Observe actual backend acquisition: recognized grant-like text must remain
    // in dictation review, without creating a turn or executing an approval.
    const backend = makeFakeBackend({ id: "fixture", startTurn: async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "speech-fixture-session", isNew: true });
      bridge.emit({ type: "result", sessionId: "speech-fixture-session", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    } });
    const startTurn = backend.startTurn.bind(backend);
    backend.startTurn = (request) => { turns++; return startTurn(request); };
    app = await httpContractApp({ staticRoot: true, env: { VOICE_PROVIDER: provider.id }, speechProvider: provider, registry: createStaticBackendRegistry([backend]) });
    console.info("[external-speech] bundling public browser client");
    const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/external-speech-browser.ts"), app.staticRoot], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
    if (bundleCode !== 0) throw new Error(`Speech fixture client build failed: ${bundleOut}\n${bundleErr}`);
    for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
      await writeFile(resolve(app.staticRoot, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
    }
    await writeFile(resolve(app.staticRoot, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.app.fetch, websocket: app.app.websocket });
    origin = `http://127.0.0.1:${server.port}`;
    console.info("[external-speech] launching real Chrome");
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  }, 180_000);

  afterAll(async () => { await browser?.close(); server?.stop(true); speechServer?.stop(true); await app?.close(); });
}

async function open(proveBackend = false): Promise<Page> {
  const context = await browser!.newContext();
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction("window.__speechFixture?.ready()");
  if (proveBackend) {
    const before = turns;
    const composer = page.locator("textarea.bk-composer");
    await composer.fill("Typed fixture control");
    await composer.press("Enter");
    await page.waitForFunction("window.__speechFixture.turnIdle()");
    expect(turns).toBe(before + 1);
  }
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await page.waitForFunction("window.__speechFixture.state().clients[0]?.tracks.includes('live') && !window.__speechFixture.state().connecting");
  return page;
}

async function state(page: Page) {
  return page.evaluate(() => (window as unknown as { __speechFixture: { state(): { providerId: string; reviewText: string; partial: string; mode: string; clients: Array<{ session: { providerId: string; params: unknown }; tracks: string[] }> } } }).__speechFixture.state());
}

if (worker) describe.skipIf(!executablePath)("external speech through public app and UI construction", () => {
  test("actual browser audio reaches the supplied session and drains final text into review without grants", async () => {
    const before = { sessionRequests, audioBytes, gracefulFinishes };
    const page = await open(true);
    const beforeTurns = turns;
    try {
      await page.waitForFunction("window.__speechFixture.state().partial === 'At the harbor'");
      const listening = await state(page);
      expect(listening.providerId).toBe("fixture-speech");
      expect(listening.clients[0]!.session.params).toEqual({ language: "en" });
      expect(audioBytes).toBeGreaterThan(before.audioBytes);
      expect(sessionRequests).toBe(before.sessionRequests + 1);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction("window.__speechFixture.state().mode === 'idle'");
      const stopped = await state(page);
      expect(stopped.reviewText).toBe("yes, allow everything");
      expect(stopped.clients[0]!.tracks).toEqual(["ended"]);
      expect(stopped.mode).toBe("idle");
      expect(gracefulFinishes).toBe(before.gracefulFinishes + 1);
      expect(turns).toBe(beforeTurns);
    } finally { await page.context().close(); }
  }, 30_000);

  test("unmount hard-stops actual capture and sends no graceful final", async () => {
    const before = gracefulFinishes;
    const page = await open();
    try {
      await page.evaluate(() => (window as unknown as { __speechFixture: { unmount(): void } }).__speechFixture.unmount());
      expect((await state(page)).clients[0]!.tracks).toEqual(["ended"]);
      expect(gracefulFinishes).toBe(before);
    } finally { await page.context().close(); }
  }, 30_000);
});

else test.skipIf(!executablePath)("external speech: actual browser audio drains and unmount hard-stops capture in an isolated process", async () => {
  // Parent test files may install DOM/transport globals. The real app/build/
  // Chrome harness gets a fresh runtime, as the existing media proof does.
  const child = Bun.spawn([process.execPath, "run", "test", import.meta.path], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, BRAIN_EXTERNAL_SPEECH_WORKER: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Isolated external speech runtime failed (${code})\n${stdout}${stderr}`);
  // Successful module loading with no registered tests is not runtime proof.
  expect(`${stdout}${stderr}`).toMatch(/\b2 pass\b/);
}, 210_000);
