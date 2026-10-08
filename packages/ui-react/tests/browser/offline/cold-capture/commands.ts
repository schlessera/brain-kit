/// <reference types="@vitest/browser-playwright" />
/** A real loopback host and Workbox worker; fresh contexts own all cache/storage.
 * Unlike route.fulfill, the HTTP server can supply an actual worker script.
 * Browser egress is denied except to this self-owned server, including workers.
 */
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { strict as assert } from "node:assert";
import type { BrowserCommand } from "vitest/node";
import type { Page } from "playwright";

interface Cell { scenario: "cold" | "reauth" | "unsupported" | "uncontrolled" | "uncached" | "continue-recording" | "dispose" | "gap" | "startup" | "restore" | "full" | "read-retry"; width: number; theme: "dark" | "light"; pointer: "fine" | "coarse" }
const fallback = "Brain needs to load once while online before it can work offline on this device.";
const base = resolve("../ui-react/tests/browser/offline/cold-capture");
let assets: Promise<Map<string, { type: string; body: string }>> | undefined;
function bundles() {
  return assets ??= (async () => {
    const bundle = async (file: string) => (await build({ entryPoints: [resolve(base, file)], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" })).outputFiles[0]!.text;
    const [app, worker, css] = await Promise.all([bundle("app.tsx"), bundle("worker.ts"), readFile(resolve("../ui-react/dist/styles.css"), "utf8")]);
    return new Map([
      ["/index.html", { type: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>' }],
      ["/app.js", { type: "text/javascript", body: app }], ["/worker.js", { type: "text/javascript", body: worker }], ["/styles.css", { type: "text/css", body: css }],
      ["/offline.html", { type: "text/html", body: fallback }],
    ]);
  })();
}
async function action<T = unknown>(page: Page, name: string): Promise<T> {
  return page.evaluate(name => (globalThis as unknown as { __offlineScene: Record<string, () => unknown> }).__offlineScene[name]!(), name) as Promise<T>;
}
async function accessible(page: Page) {
  const violations = await page.evaluate(async () => {
    const axe = (globalThis as unknown as { axe: typeof import("axe-core") }).axe;
    return (await axe.run(document.querySelector("main")!, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }));
  });
  assert.deepEqual(violations, [], "local capture passes the scoped accessibility checks");
}
async function noApiCaches(page: Page) {
  const inventory = await page.evaluate(async () => Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(r => r.url) }))));
  assert(inventory.length > 0, "the worker actually created caches");
  assert(inventory.every(c => !c.name.includes("/api") && c.urls.every(url => !new URL(url).pathname.startsWith("/api"))), `Cache Storage must contain no /api URL: ${JSON.stringify(inventory)}`);
}

export const coldCapture: BrowserCommand<[Cell], string> = async (ctx, cell) => {
  const files = await bundles();
  let online = true;
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    if (!online && path === "/api/vpn-check") { res.destroy(); return; }
    if (path === "/api/vpn-check") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ accountKey: "odysseus-ithaca" })); return; }
    if (path === "/api/files/content") { res.setHeader("Content-Type", "image/png"); res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")); return; }
    if (path.startsWith("/api")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(path.endsWith("/methods") ? { password: true, passkey: false } : { sessions: [] })); return; }
    const file = files.get(path === "/" ? "/index.html" : path);
    res.statusCode = file ? 200 : 404;
    res.setHeader("Content-Type", file?.type ?? "text/plain"); res.end(file?.body ?? "Unknown fixture resource");
  });
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = ctx.context.browser()!;
  const context = await browser.newContext({ viewport: { width: cell.width, height: 900 }, reducedMotion: "reduce", hasTouch: cell.pointer === "coarse" });
  context.setDefaultTimeout(5_000);
  try {
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    // Every worker request is observed as well; no external URL is in either bundle.
    const egress: string[] = [];
    const apiRequests: string[] = [];
    context.on("request", req => {
      const url = new URL(req.url());
      if (url.origin !== origin) egress.push(req.url());
      if (url.pathname.startsWith("/api")) apiRequests.push(url.pathname);
    });
    await context.grantPermissions(["microphone"], { origin });
    await context.addInitScript(theme => document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.classList.toggle("dark", theme === "dark");
    }), cell.theme);
    if (cell.scenario === "unsupported") await context.addInitScript(() => { Object.defineProperty(window, "MediaRecorder", { value: undefined }); });
    let page = await context.newPage();
    if (cell.scenario === "uncached") {
      await context.setOffline(true);
      await page.goto(origin).catch(() => {});
      assert.equal(await page.locator("[data-local-capture-screen]").count(), 0, "a first-ever offline visit cannot render capture");
      await context.setOffline(false);
      await page.goto(origin);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      // Remove only the shell caches, leaving the installed worker. Its actual
      // navigation handler must then produce the honest last-resort response.
      await page.evaluate(async () => { for (const name of await caches.keys()) await caches.delete(name); });
      await page.close(); await context.setOffline(true); page = await context.newPage();
      const response = await page.goto(`${origin}/never-cached`);
      assert.equal(response?.status(), 503, "uncached worker navigation uses the last-resort 503");
      assert.equal((await page.textContent("body"))?.trim(), fallback, "uncached worker fallback explains the one-online-load boundary");
      assert.equal(await page.locator("[data-local-capture-screen]").count(), 0);
      return "uncached boundary and real worker last resort passed";
    }
    await page.goto(origin);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.locator("[data-protected]").waitFor();
    await action(page, "seed");
    const image = await action<{ complete: boolean; width: number }>(page, "image");
    assert(image.complete && image.width === 1, "a real authenticated API image decoded through the controlled worker");
    await noApiCaches(page);
    assert(apiRequests.includes("/api/sessions") && apiRequests.includes("/api/files/content"), "the real network spy observed nonempty authenticated requests");
    await context.setOffline(true);
    assert.equal(await action(page, "offlineImage"), false, "the authenticated image is unavailable offline despite the warm visit");
    await context.setOffline(false);
    apiRequests.length = 0;
    if (cell.scenario === "reauth" || cell.scenario === "restore") {
      await action(page, "expire");
      await page.getByRole("heading", { name: "Your sign-in has expired" }).waitFor();
      await page.waitForTimeout(350);
      if (cell.scenario === "restore") {
        await action(page, "beginRestore");
        await page.waitForFunction(() => (globalThis as unknown as { __offlineScene: { restoreWaiting(): boolean } }).__offlineScene.restoreWaiting());
        const local = page.getByRole("button", { name: "Record without signing in" });
        assert.equal(await local.getAttribute("aria-disabled"), "true", "local entry is disabled while same-account restoration is pending");
        await local.evaluate(el => (el as HTMLElement).click());
        assert.equal(await page.locator("[data-local-capture-screen]").count(), 0, "the local action cannot replace active account restoration");
        assert.equal(await action(page, "finishRestore"), true);
        await page.locator("[data-protected]").waitFor();
        return "pending account restore cannot enter local capture passed";
      }
      apiRequests.length = 0;
      await page.getByRole("button", { name: "Record without signing in" }).click();
    } else {
      if (cell.scenario === "startup") await action(page, "startupGap");
      if (cell.scenario === "full") await action(page, "fullStartup");
      if (cell.scenario === "read-retry") await action(page, "transientStartup");
      await page.close();
      apiRequests.length = 0;
      await context.setOffline(true);
      page = await context.newPage();
      if (cell.scenario === "uncontrolled") {
        await context.setOffline(false);
        await page.goto(origin);
        await page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); });
        online = false;
        await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({} as ServiceWorkerRegistration); });
        await page.close(); page = await context.newPage();
        await page.goto(origin);
      } else await page.goto(origin);
    }
    if (cell.scenario === "unsupported" || cell.scenario === "uncontrolled") {
      await page.getByRole("heading", { name: "Unable to reach server" }).waitFor();
      assert.equal(await page.locator("[data-local-capture-screen]").count(), 0, "unsupported or uncontrolled launch retains the gate");
      if (cell.scenario === "unsupported") assert((await page.textContent("body"))?.includes("This browser can't save recordings on the device."), "unsupported browser gets T1's sentence");
      return "unsupported/uncontrolled boundary passed";
    }
    await page.getByRole("heading", { name: "Can't reach your server" }).waitFor();
    assert.equal(await page.locator("[data-protected]").count(), 0, "cold capture never mounts protected content");
    assert.equal(await page.locator("h1").evaluate(el => el === document.activeElement), true, "focus lands on the local screen's title");
    if (cell.scenario === "startup") {
      await page.waitForFunction(() => (globalThis as unknown as { __offlineScene: { recoveryWaiting(): boolean } }).__offlineScene.recoveryWaiting());
      await page.waitForTimeout(150);
      assert.equal(await page.getByRole("button", { name: /^Play recording/ }).count(), 0, "startup recovery exposes no unrepaired playback controls");
      assert.equal(await page.getByRole("button", { name: "Record on this device", exact: true }).getAttribute("aria-disabled"), "true", "capture waits for startup recovery");
      await action(page, "releaseRecovery");
      await page.getByRole("button", { name: /^Play recording/ }).waitFor();
      return "startup recovery gates playback passed";
    }
    if (cell.scenario === "read-retry") {
      await page.waitForFunction(() => (globalThis as unknown as { __offlineScene: { inventoryFailed(): boolean } }).__offlineScene.inventoryFailed());
      await page.getByRole("button", { name: /^Play recording/ }).waitFor();
      assert.equal(await page.getByRole("button", { name: /^Play recording/ }).count(), 1, "retained recordings return after a transient inventory read without a store event");
      return "inventory read retry passed";
    }
    if (cell.scenario === "full") {
      await page.getByRole("button", { name: /^Play recording/ }).click();
      const bytes = await page.locator("audio").evaluate(async el => (await (await fetch((el as HTMLAudioElement).src)).blob()).size);
      assert.equal(bytes, 320044, "a full origin cold launch preserves playback of the committed prefix");
      await page.getByRole("button", { name: /^Discard recording/ }).click();
      await page.getByRole("button", { name: /^Delete recording/ }).click();
      await page.getByRole("button", { name: /^Play recording/ }).waitFor({ state: "detached" });
      assert.equal((await action<unknown[]>(page, "inventory")).length, 0, "saved audio can be discarded on a full origin");
      return "full-origin cold launch preserves playback and discard passed";
    }
    await page.locator("[data-locked-recordings]").waitFor();
    assert((await page.textContent("[data-locked-recordings]"))?.startsWith("Locked recordings · "), "locked recordings show only aggregate size");
    const dom = await page.content();
    for (const secret of ["ithaca-secret", "Secret plan for the Sirens", "2026-07-12", "12:00", "0:10"]) assert(!dom.includes(secret), `locked metadata ${secret} must not appear in the DOM`);
    assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), cell.pointer === "coarse", "the cell uses its real pointer mode");
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), cell.theme, "the cell uses its real theme");
    await page.addScriptTag({ content: await readFile(resolve("../../node_modules/axe-core/axe.min.js"), "utf8") });
    await accessible(page);
    if (cell.width === 320 && cell.pointer === "fine") {
      await mkdir(resolve("../../tmp/cold-capture"), { recursive: true });
      await page.screenshot({ path: resolve(`../../tmp/cold-capture/${cell.theme}.png`), fullPage: true });
    }
    if (cell.scenario === "gap") {
      const repaired = await action<{ bytes: number; failures: number; row: { chunkCount: number; savedThroughMs: number } }>(page, "gap");
      assert(repaired.failures > 0 && repaired.row.chunkCount === 1 && repaired.row.savedThroughMs === 1000, "recovery excluded a post-gap chunk and could not persist its repair");
      await page.getByRole("button", { name: /^Play recording/ }).click();
      const playedBytes = await page.locator("audio").evaluate(async el => (await (await fetch((el as HTMLAudioElement).src)).blob()).size);
      assert.equal(playedBytes, repaired.bytes, "local playback uses the recovering store's contiguous-prefix repair");
      await action(page, "restoreQuota");
      return "full-origin recovered playback passed";
    }
    await page.waitForTimeout(350);
    const start = page.getByRole("button", { name: "Record on this device", exact: true });
    if (cell.pointer === "fine") { await start.click({ trial: true }); await start.focus(); await start.press("Enter"); }
    else await start.click();
    await page.waitForFunction(() => (globalThis as unknown as { __offlineScene: { phase(): string } }).__offlineScene.phase() === "recording");
    assert.equal(await page.getByRole("button", { name: "Stop and save", exact: true }).evaluate(el => el === document.activeElement), true, "starting capture transfers focus to Stop and save");
    await accessible(page);
    await page.waitForTimeout(1300);
    if (cell.scenario === "dispose") {
      assert.equal(await action(page, "microphoneLive"), true, "the disposal test has a live real microphone to observe");
      await action(page, "dispose");
      await page.waitForTimeout(200);
      assert.equal(await action(page, "microphoneLive"), false, "root disposal stops the local screen's microphone while it remains mounted");
      assert.equal(await page.locator("[data-local-capture-screen]").count(), 1);
      return "root-owned recorder disposal passed";
    }
    await context.setOffline(false);
    await page.getByRole("button", { name: "Try now", exact: true }).click();
    await page.getByText("Your server is back.", { exact: true }).waitFor();
    assert.equal(await action(page, "phase"), "recording", "probe recovery keeps the microphone running");
    assert.equal(await page.locator("[data-protected]").count(), 0, "recovery waits for explicit Continue");
    if (cell.scenario === "continue-recording") {
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.locator("[data-protected]").waitFor();
      const kept = await action<Array<{ state: string; partition: string; bytes: number }>>(page, "inventory");
      assert.equal(kept.length, 1, "Continue retains the live capture");
      assert.equal(kept[0]!.state, "saved", "Continue commits the final capture before mounting protected content");
      assert.equal(kept[0]!.partition, "unassigned");
      assert(kept[0]!.bytes > 0);
      await noApiCaches(page);
      return "Continue drains and retains the recording before departure passed";
    }
    await page.getByRole("button", { name: "Stop and save", exact: true }).click();
    await page.waitForFunction(() => (globalThis as unknown as { __offlineScene: { phase(): string } }).__offlineScene.phase() === "idle");
    const rows = await action<Array<{ partition: string; bytes: number; savedThroughMs: number }>>(page, "inventory");
    assert.equal(rows.length, 1, "cold/reauth capture durably saves one recording");
    assert.equal(rows[0]!.partition, "unassigned", "new local capture belongs to unassigned");
    assert(rows[0]!.bytes > 0 && rows[0]!.savedThroughMs > 0, "the saved capture has real committed audio");
    await page.getByRole("button", { name: /^Play recording/ }).click();
    await page.locator("audio").waitFor();
    await page.waitForFunction(() => { const audio = document.querySelector("audio"); return !!audio && audio.currentTime > 0 && !audio.paused; });
    await accessible(page);
    assert.equal(await page.locator("audio").evaluate(el => (el as HTMLAudioElement).error), null, "unassigned audio plays in Chromium");
    const calls = await action<string[]>(page, "requests");
    if (cell.scenario === "cold" || cell.scenario === "reauth") assert.deepEqual([...new Set(apiRequests)], ["/api/vpn-check"], "the browser network spy sees only the connectivity probe during cold capture and recovery");
    if (cell.scenario === "cold") assert.deepEqual([...new Set(calls)], ["/api/vpn-check"], "the local screen makes only the connectivity probe, including after recovery");
    await noApiCaches(page);
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= window.innerWidth), true, "local screen fits the viewport");
    assert.equal(await page.locator("main > div").evaluate(el => el.getBoundingClientRect().width <= 480), true, "desktop column is capped at 480px");
    const targets = await page.getByRole("button").evaluateAll(els => els.map(el => ({ label: el.getAttribute("aria-label"), height: el.getBoundingClientRect().height })));
    assert(targets.every(t => t.height >= 44), `capture controls have 44px targets: ${JSON.stringify(targets)}`);
    assert.equal(egress.length, 0, "cold-capture harness has no external egress");
    if (cell.scenario === "cold") {
      await page.close(); await context.setOffline(true); page = await context.newPage();
      await page.goto(origin);
      await page.getByRole("heading", { name: "Can't reach your server" }).waitFor();
      await page.getByRole("button", { name: /^Play recording/ }).waitFor();
      assert.equal(await action(page, "phase"), "idle", "cold recovery never restarts the microphone");
      assert.equal((await action<unknown[]>(page, "inventory")).length, 1, "unassigned capture survives another cold launch");
      await page.getByRole("button", { name: /^Play recording/ }).click();
      await page.waitForFunction(() => { const audio = document.querySelector("audio"); return !!audio && audio.currentTime > 0 && !audio.paused; });
      await context.setOffline(false);
      await page.getByRole("button", { name: "Try now", exact: true }).click();
      await page.getByText("Your server is back.", { exact: true }).waitFor();
    }
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (cell.scenario === "reauth") await page.getByRole("heading", { name: "Your sign-in has expired" }).waitFor();
    else await page.locator("[data-protected]").waitFor();
    await noApiCaches(page);
    return "capture, playback, isolation, reconnect, focus and cache assertions passed";
  } finally {
    await context.close();
    await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
  }
};

declare module "vitest/browser" { interface BrowserCommands { coldCapture(cell: Cell): Promise<string> } }
