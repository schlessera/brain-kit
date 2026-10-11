/// <reference types="@vitest/browser-playwright" />
/**
 * #689 AC1: two real browser devices resolve an autonomous decision against
 * the real app and gated production dispatcher, which then applies the exact
 * change once. Server and Chromium both run inside the network-disabled
 * browser container.
 */
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import type { ClientInboxResolve } from "@schlessera/brain-ui-sdk/protocol";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { BrowserCommand } from "vitest/node";

interface State { actions: Array<{ id: string; status: string }>; executes: string[]; resolutions: number; note: string | null; applied: Array<{ ok: boolean; code?: string }> }

type Ordering = "two-confirmations" | "terminal-during-press";

export const dispatchActions: BrowserCommand<[Ordering], unknown> = async (ctx, ordering) => {
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
    const decisions: Array<{ device: string; message: ClientInboxResolve }> = [];
    const held: Array<() => void> = [];
    const sequence: string[] = [];
    const decisionWaiters = new Map<string, () => void>();
    const socketUrl = url.replace("http:", "ws:") + "/ws";
    for (const [device, page] of [["phone", phone], ["laptop", laptop]] as const) {
      // Forward unchanged browser bytes to the actual app, but only after the
      // native confirmations have finished. Server replication stays live.
      await page.routeWebSocket(socketUrl, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((bytes) => {
          const message = JSON.parse(String(bytes));
          if (message.type !== "inbox_resolve") { server.send(bytes); return; }
          decisions.push({ device, message });
          sequence.push(`${device}:outbound-decision-held`);
          held.push(() => { sequence.push(`${device}:decision-forwarded`); server.send(bytes); });
          decisionWaiters.get(device)?.();
        });
      });
    }
    const waitForDecision = async (device: string) => {
      if (decisions.some(d => d.device === device)) return;
      await new Promise<void>((res, reject) => {
        const timer = setTimeout(() => {
          decisionWaiters.delete(device);
          reject(new Error(`missing routed decision: ${device}`));
        }, 10_000);
        decisionWaiters.set(device, () => { clearTimeout(timer); decisionWaiters.delete(device); res(); });
      });
    };
    await phone.goto(`${origin}/dispatch-actions`);
    await laptop.goto(`${origin}/dispatch-actions`);
    const approve = (page: typeof phone) => page.getByRole("button", { name: "Approve: write_file notes/ithaca-loom.md" }).first();
    const receipt = (page: typeof phone) => page.locator("[aria-live='polite'], [data-decision-receipt]").filter({ hasText: /queued write_file|Resolved on another device/ }).first();
    await approve(phone).waitFor({ timeout: 10_000 });
    await approve(laptop).waitFor({ timeout: 10_000 });
    if (ordering === "terminal-during-press") {
      const box = await approve(laptop).boundingBox();
      assert.ok(box, "native approval has a painted target");
      await laptop.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await laptop.mouse.down();
      sequence.push("laptop:native-press-started");
    }
    await approve(phone).click();
    sequence.push("phone:native-click-complete");
    await waitForDecision("phone");
    const duringHold = await control("state") as State;
    assert.equal(duringHold.resolutions, 0, "TWO_DEVICE_BARRIER: no resolution before native confirmations finish");
    if (ordering === "two-confirmations") {
      await approve(laptop).click();
      sequence.push("laptop:native-click-complete");
      await waitForDecision("laptop");
      assert.deepEqual(decisions.map(d => d.device), ["phone", "laptop"], "TWO_NATIVE_DECISIONS: both browser frames observed before release");
    }
    const beforeRelease = await control("state") as State;
    for (const forward of held) forward();
    if (ordering === "terminal-during-press") {
      await approve(laptop).waitFor({ state: "detached", timeout: 10_000 });
      await receipt(laptop).waitFor({ timeout: 10_000 });
      // Observe a painted frame after terminal replication, then finish the
      // original native press at its original coordinates. No forced/retried
      // locator click or synthetic DOM input is used.
      await laptop.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())));
      sequence.push("laptop:terminal-painted-before-release");
      await laptop.mouse.up();
      await laptop.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())));
      sequence.push("laptop:native-press-finished");
    }
    await receipt(phone).waitFor({ timeout: 10_000 });
    await receipt(laptop).waitFor({ timeout: 10_000 });
    const receipts = [await receipt(phone).innerText(), await receipt(laptop).innerText()];
    const traces = await Promise.all([phone, laptop].map(page => page.evaluate(() =>
      (window as unknown as { __dispatchTrace: unknown[] }).__dispatchTrace)));
    const resolved = await control("state") as State;
    const applied = await control("poke");
    const after = await control("state") as State;
    const result = { arrival: arrival.itemId, escalated, before, duringHold, beforeRelease, decisions, sequence, traces, receipts, resolved, applied, after, diagnostics };
    mkdirSync(resolve("../../tmp"), { recursive: true });
    writeFileSync(resolve(`../../tmp/dispatch-actions-${ordering}-probe.json`), JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    for (const page of context.pages()) diagnostics.push((await page.locator("body").innerText()).slice(0, 1500));
    throw new Error(`${String(error)}\n${diagnostics.join("\n")}\n${stderr.slice(-2000)}`);
  } finally {
    await context.close();
    child.kill();
  }
};
