/// <reference types="@vitest/browser-playwright" />
/**
 * #689 AC1: two real browser devices resolve an autonomous decision against
 * the real app and gated production dispatcher, which then applies the exact
 * change once. Server and Chromium both run inside the network-disabled
 * browser container.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";

interface State { actions: Array<{ id: string; status: string }>; executes: string[]; resolutions: number; note: string | null; applied: Array<{ ok: boolean; code?: string }> }

export const dispatchActions: BrowserCommand<[], unknown> = async (ctx) => {
  const origin = new URL(ctx.page.url()).origin;
  const child = spawn(process.env.BUN_BIN ?? "bun",
    ["--preload", resolve("../../scripts/test-network-child-preload.ts"), resolve("../ui-react/tests/fixtures/dispatch-browser-server.ts"), origin],
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
  const control = async (op: string) => await (await fetch(`${url}/fixture`, { method: "POST", body: JSON.stringify({ op }) })).json();
  const context = await ctx.context.browser()!.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  // The pinned Chromium requires this origin-scoped permission for loopback sockets.
  await context.grantPermissions(["local-network-access"], { origin });
  const html = `<html data-theme="dark"><body style="margin:0"><div id="scene" class="bg-background text-foreground" style="height:100vh;display:flex"></div><script>window.__dispatchUrl=${JSON.stringify(url)}</script><script type="module" src="/@fs${resolve("../ui-react/tests/browser/dispatch-actions-scene.tsx")}"></script></body></html>`;
  const diagnostics: string[] = [];
  context.on("page", (page) => {
    page.on("pageerror", (e) => diagnostics.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") diagnostics.push(m.text()); });
  });
  try {
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (target.origin !== origin) { await route.abort(); return; }
      if (target.pathname === "/dispatch-actions") { await route.fulfill({ contentType: "text/html", body: html }); return; }
      await route.continue();
    });
    const arrival = await control("arrive") as { itemId: string };
    const escalated = await control("poke");
    const before = await control("state") as State;
    const phone = await context.newPage(), laptop = await context.newPage();
    await phone.goto(`${origin}/dispatch-actions`);
    await laptop.goto(`${origin}/dispatch-actions`);
    const approve = (page: typeof phone) => page.getByRole("button", { name: "Approve: write_file notes/ithaca-loom.md" }).first();
    await approve(phone).waitFor({ timeout: 10_000 });
    await approve(laptop).waitFor({ timeout: 10_000 });
    // Both devices tap Approve on the same decision.
    await Promise.all([approve(phone).click(), approve(laptop).click()]);
    // The last decision leaves an empty list, so the receipt is the polite live region.
    const receipt = (page: typeof phone) => page.locator("[aria-live='polite']").filter({ hasText: "queued write_file" }).first();
    await receipt(phone).waitFor({ timeout: 10_000 });
    await receipt(laptop).waitFor({ timeout: 10_000 });
    const receipts = [await receipt(phone).innerText(), await receipt(laptop).innerText()];
    const resolved = await control("state") as State;
    const applied = await control("poke");
    const after = await control("state") as State;
    return { arrival: arrival.itemId, escalated, before, receipts, resolved, applied, after, diagnostics };
  } catch (error) {
    for (const page of context.pages()) diagnostics.push((await page.locator("body").innerText()).slice(0, 1500));
    throw new Error(`${String(error)}\n${diagnostics.join("\n")}\n${stderr.slice(-2000)}`);
  } finally {
    await context.close();
    child.kill();
  }
};
