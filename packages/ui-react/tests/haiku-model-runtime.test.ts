import { chromePath, startRuntimeHost, type RuntimeHost } from "./fixtures/runtime-host";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Browser } from "playwright";

const executablePath = chromePath("haiku-model-runtime.test.ts");
let host: RuntimeHost | undefined;
let browser: Browser;
let origin = "";
beforeAll(async () => {
  if (!executablePath) return;
  // No app: the production composer alone, against a static page.
  host = await startRuntimeHost({ file: "haiku-model-runtime.test.ts", executablePath, packages: ["ui-react"], scratchPrefix: "haiku-browser-",
    client: join(import.meta.dir, "fixtures/haiku-model-browser.tsx"),
    page: '<!doctype html><html><head><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column;justify-content:flex-end}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>' });
  ({ browser, origin } = host);
}, 180_000);
afterAll(() => host?.close());

test.skipIf(!executablePath)("real Chrome selects, persists and sends canonical Haiku 5.5 through the production composer", async () => {
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
