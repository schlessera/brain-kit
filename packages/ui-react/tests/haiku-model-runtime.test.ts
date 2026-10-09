import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .find(path => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath) throw new Error("Haiku picker verification requires real Chrome");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const scratch = mkdtempSync(join(tmpdir(), "haiku-browser-"));
beforeAll(async () => {
  // Browser consumers follow the published default exports, which resolve to
  // dist. Build those outputs; never force a Bun condition in the consumer.
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Haiku fixture build failed (${code}): ${out}\n${err}`);
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/haiku-model-browser.tsx")], target: "browser", outdir: scratch, naming: "client.js" });
  if (!built.success) throw new Error(JSON.stringify(built.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    const path = new URL(req.url).pathname;
    if (path === "/client.js") return new Response(Bun.file(join(scratch, "client.js")));
    if (path === "/kit.css") return new Response(Bun.file(join(import.meta.dir, "../../ui-kit/dist/styles.css")));
    if (path === "/app.css") return new Response(Bun.file(join(import.meta.dir, "../dist/styles.css")));
    return new Response('<!doctype html><html><head><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column;justify-content:flex-end}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  } });
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 180_000);
afterAll(async () => { await browser?.close(); server?.stop(true); rmSync(scratch, { recursive: true, force: true }); });

test("real Chrome selects, persists and sends canonical Haiku 5.5 through the production composer", async () => {
  const origin = `http://127.0.0.1:${server.port}`;
  const context = await browser.newContext();
  const external: string[] = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  try {
    const page = await context.newPage(); await page.goto(origin);
    await page.getByRole("button", { name: /^Model —/ }).click();
    await page.getByRole("radio", { name: "Claude Haiku 5.5" }).check();
    await page.getByRole("button", { name: /Model — Claude Haiku 5.5/ }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { __haikuFixture: { selected(): string } }).__haikuFixture.selected())).toBe("claude-haiku-5-5");
    await page.reload();
    await page.getByRole("button", { name: /Model — Claude Haiku 5.5/ }).waitFor();
    await page.getByRole("textbox").fill("Tell Odysseus about Ithaca.");
    await page.getByRole("textbox").press("Enter");
    const sent = await page.evaluate(() => (window as unknown as { __haikuFixture: { sent: Array<{ providerId: string; text: string }> } }).__haikuFixture.sent);
    expect(sent).toHaveLength(1); expect(sent[0]!.providerId).toBe("claude-haiku-5-5");
    expect(sent[0]!.text).toBe("Tell Odysseus about Ithaca."); expect(external).toEqual([]);
  } finally { await context.close(); }
});
