/// <reference types="@vitest/browser-playwright" />
/**
 * #3812: one chat carries a permanent safety-recording gap, and a second
 * chat stays usable beside it. The real Chat page in Chromium talks to the
 * real app (its own WebSocket, draft routes and safety recorder) served by
 * `../fixtures/safety-gap-browser-server.ts`. Server and Chromium both run
 * inside the network-disabled browser container.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";

interface Chat { restriction: string; coverage: string; gap: boolean; available: boolean }
interface State { turns: Array<{ sessionId: string; prompt: string; outcome: string }>; brainLatched: boolean; chats: Record<string, Chat> }
/** The host's state after the gap and after the second chat, and what the page showed. */
export interface SafetyGapChats { gapped: State; after: State; refusalCopy: boolean; composerDisabled: string | null; diagnostics: string[] }

export const safetyGapChats: BrowserCommand<[], SafetyGapChats> = async (ctx) => {
  const origin = new URL(ctx.page.url()).origin;
  const child = spawn(process.env.BUN_BIN ?? "bun",
    ["--preload", resolve("../../scripts/test-network-child-preload.ts"), resolve("../ui-react/tests/fixtures/safety-gap-browser-server.ts"), origin],
    { cwd: resolve("../.."), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", stdout = "";
  child.stderr!.on("data", (b) => { stderr += String(b); });
  const url = await new Promise<string>((res, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`fixture timeout: ${stderr}`)); }, 20_000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${stderr}`)); });
    child.stdout!.on("data", (b) => {
      stdout += String(b);
      if (stdout.includes("\n")) { clearTimeout(timer); try { res(JSON.parse(stdout.split("\n")[0]!).url); } catch (e) { reject(e); } }
    });
  });
  const state = async () => await (await fetch(`${url}/fixture`)).json() as State;
  // Below 1280 the Chat page draws its own New chat disc.
  const context = await ctx.context.browser()!.newContext({ viewport: { width: 1024, height: 800 }, reducedMotion: "reduce" });
  // The pinned Chromium requires this origin-scoped permission for loopback sockets.
  await context.grantPermissions(["local-network-access"], { origin });
  // Vitest's browser transform routes each dynamic import through its
  // runner; this page is not the runner's, so the Chat page's lazy imports
  // load directly.
  const html = `<html data-theme="dark"><body style="margin:0"><div id="scene" class="bg-background text-foreground" style="height:100vh;display:flex;flex-direction:column"></div><script>window.__safetyGapUrl=${JSON.stringify(url)};window.__vitest_browser_runner__={wrapDynamicImport:load=>load()}</script><script type="module" src="/@fs${resolve("../ui-react/tests/browser/safety-gap-scene.tsx")}"></script></body></html>`;
  const diagnostics: string[] = [];
  context.on("page", (page) => {
    page.on("pageerror", (e) => diagnostics.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") diagnostics.push(m.text()); });
  });
  try {
    const app = new URL(url).origin;
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (target.origin !== origin && target.origin !== app) { await route.abort(); return; }
      if (target.origin === origin && target.pathname === "/safety-gap") { await route.fulfill({ contentType: "text/html", body: html }); return; }
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/safety-gap`);
    const field = page.locator("[data-composer] textarea");
    const send = async (text: string, answer: string) => {
      await field.waitFor({ timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector("[data-composer] textarea")?.getAttribute("placeholder") !== "Connecting...", undefined, { timeout: 10_000 });
      await field.fill(text);
      await page.locator('[data-composer] [aria-label^="Send"]').click();
      await page.getByText(answer, { exact: false }).first().waitFor({ timeout: 10_000 });
    };
    // The first chat's search result reaches the runtime; its record is refused.
    await send("Listen for the sirens.", "The wax is in the crew's ears.");
    const gapped = await state();
    // A second chat, from the page's own New chat.
    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("The wax is in the crew's ears."), undefined, { timeout: 10_000 });
    await send("Steer for Ithaca.", "The crew rows on: Steer for Ithaca.");
    await send("Row past Scylla.", "The crew rows on: Row past Scylla.");
    const after = await state();
    const body = await page.locator("body").innerText();
    return { gapped, after, refusalCopy: /Safety recording|brain refused/i.test(body),
      composerDisabled: await page.locator('[data-composer] [aria-label^="Send"]').getAttribute("aria-disabled"), diagnostics };
  } catch (error) {
    for (const page of context.pages()) diagnostics.push((await page.locator("body").innerText()).slice(0, 1500));
    throw new Error(`${String(error)}\n${diagnostics.join("\n")}\n${stderr.slice(-2000)}`);
  } finally {
    await context.close();
    child.kill();
  }
};
declare module "vitest/browser" { interface BrowserCommands { safetyGapChats: () => Promise<SafetyGapChats> } }
