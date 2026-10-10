/// <reference types="@vitest/browser-playwright" />
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Route } from "playwright";
import type { BrowserCommand } from "vitest/node";

type Op =
  | { op: "start" }
  | { op: "set"; id: string; patch: Record<string, unknown> }
  | { op: "stop"; id: string }
  | { op: "ax"; selector: string }
  | { op: "native"; id: string; width: number; theme: string }
  | { op: "capture"; name: string; selector: string };
const servers = new Map<
  string,
  { process: ChildProcess; url: string; pending: Set<Promise<void>>; handler: (route: Route) => Promise<void> }
>();
/** Native server runs inside the same network-disabled browser container. */
export const hygieneServer: BrowserCommand<[Op], unknown> = async (ctx, p) => {
  if (p.op === "ax") {
    const session = await ctx.context.newCDPSession(ctx.page);
    try {
      const { frameTree } = await session.send("Page.getFrameTree");
      type Tree = typeof frameTree;
      const ids = (t: Tree): string[] => [t.frame.id, ...(t.childFrames ?? []).flatMap(ids)];
      const trees = await Promise.all(
        ids(frameTree).map((frameId) => session.send("Accessibility.getFullAXTree", { frameId }))
      );
      return { nodes: trees.flatMap((tree) => tree.nodes) };
    } finally {
      await session.detach();
    }
  }
  if (p.op === "capture") {
    const frame = await ctx.frame();
    const path = resolve(tmpdir(), p.name);
    await frame.locator(p.selector).screenshot({ path });
    return path;
  }
  if (p.op === "start") {
    const child = spawn(
      process.env.BUN_BIN ?? "bun",
      [
        "--preload",
        resolve("../../scripts/test-network-child-preload.ts"),
        resolve("../ui-react/tests/fixtures/hygiene-browser-server.ts"),
      ],
      { cwd: resolve("../.."), env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "",
      stdout = "";
    child.stderr!.on("data", (b) => {
      stderr += String(b);
    });
    const url = await new Promise<string>((res, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`fixture timeout: ${stderr}`));
      }, 15_000);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`fixture exited ${code}: ${stderr}`));
      });
      child.stdout!.on("data", (b) => {
        stdout += String(b);
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          try {
            res(JSON.parse(stdout.split("\n")[0]).url);
          } catch (e) {
            reject(e);
          }
        }
      });
    });
    const id = crypto.randomUUID();
    const pending = new Set<Promise<void>>();
    const handler = async (route: Route) => {
      const task = (async () => {
        const req = route.request(),
          path = new URL(req.url()).pathname;
        const r = await fetch(`${url}${path}`, {
          method: req.method(),
          headers: { "content-type": "application/json" },
          ...(req.postData() ? { body: req.postData()! } : {}),
        });
        await route.fulfill({ status: r.status, contentType: "application/json", body: await r.text() });
      })();
      pending.add(task);
      try {
        await task;
      } finally {
        pending.delete(task);
      }
    };
    servers.set(id, { process: child, url, pending, handler });
    await ctx.page.route("**/api/hygiene/**", handler);
    return { id, url, scratch: tmpdir() };
  }
  const s = servers.get(p.id)!;
  if (p.op === "native") {
    const browser = ctx.context.browser()!;
    const context = await browser.newContext({
      viewport: { width: p.width, height: 1000 },
      reducedMotion: "reduce",
      hasTouch: p.width === 320,
    });
    const origin = new URL(ctx.page.url()).origin;
    // The pinned Chromium requires this origin-scoped permission for loopback sockets.
    // The container remains network-disabled and the context rejects other HTTP origins.
    await context.grantPermissions(["local-network-access"], { origin });
    const html = `<html data-theme="${
      p.theme
    }"><body style="margin:0"><div id="scene" class="bg-background text-foreground" style="height:100vh;display:flex"></div><script>window.__c5Url=${JSON.stringify(
      s.url
    )}</script><script type="module" src="/@fs${resolve(
      "../ui-react/tests/browser/hygiene-reload-scene.tsx"
    )}"></script></body></html>`;
    const diagnostics: string[] = [];
    context.on("page", (page) => {
      page.on("pageerror", (e) => diagnostics.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") diagnostics.push(m.text());
      });
      page.on("requestfailed", (req) => diagnostics.push(`${req.url()}: ${req.failure()?.errorText}`));
    });
    try {
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          await route.abort();
          return;
        }
        if (url.pathname === "/c5-native") {
          await route.fulfill({ contentType: "text/html", body: html });
          return;
        }
        if (url.pathname.startsWith("/api/hygiene/")) {
          const req = route.request();
          const response = await fetch(`${s.url}${url.pathname}`, {
            method: req.method(),
            headers: { "content-type": "application/json" },
            ...(req.postData() ? { body: req.postData()! } : {}),
          });
          await route.fulfill({
            status: response.status,
            contentType: "application/json",
            body: await response.text(),
          });
          return;
        }
        await route.continue();
      });
      const a = await context.newPage();
      await a.goto(`${origin}/c5-native`);
      await a.locator("[data-hygiene-id]").waitFor({ timeout: 5000 });
      const id = await a.locator("[data-hygiene-id]").first().getAttribute("data-hygiene-id");
      await a.getByRole("button", { name: "Pause", exact: true }).click();
      await a.getByText("Hygiene review paused", { exact: true }).waitFor({ timeout: 5000 });
      await a.reload();
      await a.getByText("Hygiene review paused", { exact: true }).waitFor({ timeout: 5000 });
      if ((await a.locator("[data-hygiene-id]").first().getAttribute("data-hygiene-id")) !== id)
        throw new Error("native reload changed the pending Action");
      await a.getByRole("button", { name: "Resume", exact: true }).click();
      await a.getByText("● Hygiene review · 1 of 2 open", { exact: true }).waitFor({ timeout: 5000 });
      await a.evaluate(() => (window as unknown as { __c5Reconnect(): void }).__c5Reconnect());
      await a.getByText("● Hygiene review · 1 of 2 open", { exact: true }).waitFor({ timeout: 5000 });
      const b = await context.newPage();
      await b.goto(`${origin}/c5-native`);
      await b.locator("[data-hygiene-id]").waitFor({ timeout: 5000 });
      if ((await b.locator("[data-hygiene-id]").first().getAttribute("data-hygiene-id")) !== id)
        throw new Error("second device did not restore the pending Action");
      if (p.width >= 900) await b.getByRole("button", { name: /^Open finding:/ }).click();
      const radio = b.getByRole("radio", { name: "Keep the text, remove the link", exact: true });
      const apply = b.getByRole("button", { name: "Apply fix", exact: true });
      const target = await apply.boundingBox();
      if (!target || target.height < 44 || target.width < 44) throw new Error("Apply target is smaller than 44px");
      const fine = await b.evaluate(() => matchMedia("(any-pointer: fine)").matches);
      if (fine !== p.width >= 900) throw new Error("native pointer premise does not match the fixture");
      if (p.width === 320) {
        const card = await b.locator("[data-hygiene-card]").boundingBox();
        const later = await b.getByRole("button", { name: "Later ▾", exact: true }).boundingBox();
        if (!card || Math.abs(target.width - card.width) > 1 || !later || later.y < target.y + target.height)
          throw new Error("phone Apply must occupy its own full-width row before Later");
      }
      if (p.width === 320) {
        await radio.tap();
        await apply.tap();
      } else {
        await radio.check();
        await apply.click();
      }
      await a.getByText("Resolved on another device", { exact: true }).first().waitFor({ timeout: 5000 });
      await b.getByText("Another link points to a missing note", { exact: true }).first().waitFor({ timeout: 5000 });
      await a.screenshot({ path: resolve(tmpdir(), `c5-native-${p.theme}-${p.width}.png`) });
      return { sameAction: true, reload: true, reconnect: true, foreignReceipt: true, touch: p.width === 320 };
    } catch (error) {
      for (const page of context.pages()) diagnostics.push((await page.locator("body").innerText()).slice(0, 1000));
      throw new Error(`${String(error)}\n${diagnostics.join("\n")}`);
    } finally {
      await context.close();
    }
  }
  if (p.op === "set")
    return (
      await fetch(`${s.url}/fixture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p.patch),
      })
    ).json();
  // Client disposal invalidates reads, but the HTTP route still owes its response.
  await Promise.all([...s.pending]);
  await ctx.page.unroute("**/api/hygiene/**", s.handler);
  const ended = once(s.process, "exit");
  s.process.kill("SIGTERM");
  const [code, signal] = await ended;
  if (code !== 0 || signal !== null) throw new Error(`fixture cleanup failed: ${code}/${signal}`);
  servers.delete(p.id);
};
declare module "vitest/browser" {
  interface BrowserCommands {
    hygieneServer: (op: Op) => Promise<unknown>;
  }
}
