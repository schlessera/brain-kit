/**
 * Node side of the page-level fault primitives (#1016): reload and terminate a
 * whole page in the middle of an operation.
 *
 * A Vitest browser test runs inside the runner's iframe, and reloading or
 * killing that frame would take the test with it. So a test opens a *scene*:
 * a top-level page in its own browser context (its own storage, nothing shared
 * with the runner or another scene), which loads one module from the same Vite
 * server. The test drives it through this one command, and the scene's
 * storage survives a reload or a termination exactly as a user's would.
 *
 * - `reload` is a user's reload. Unload handlers run; a `beforeunload` prompt
 *   is accepted, so a guard cannot stall the test.
 * - `terminate` crashes the renderer through CDP (`Page.crash`): no
 *   `beforeunload`, `pagehide` or `unload` handler runs, as when the OS kills
 *   a backgrounded tab. The scene is then launched again in a new page of the
 *   same context: the next launch, with whatever storage committed.
 *
 * Chromium only (CDP), which is the project this is registered on
 * (`ui-react-layout` in `packages/ui-kit/vitest.config.ts`). The browser-side
 * wrapper is `scene.ts`.
 */
/// <reference types="@vitest/browser-playwright" />
import type { BrowserContext, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";

export type SceneOp =
  /** `module`: the scene's path on the Vite server, `new URL(file, import.meta.url).pathname`. */
  | { op: "open"; module: string }
  | { op: "call"; id: string; action: string; args: unknown[] }
  | { op: "reload"; id: string }
  | { op: "terminate"; id: string }
  | { op: "close"; id: string };

interface Scene {
  context: BrowserContext;
  page: Page;
  url: string;
}

const scenes = new Map<string, Scene>();
let next = 0;

function scene(id: string): Scene {
  const found = scenes.get(id);
  if (!found) throw new Error(`no open scene ${id}`);
  return found;
}

async function attach(s: Scene, page: Page) {
  s.page = page;
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
}

/** Wait for the scene's module to have registered its actions. */
async function registered(page: Page) {
  await page.waitForFunction(() => "__offlineScene" in globalThis, undefined, { timeout: 15_000 });
}

export const offlineScene: BrowserCommand<[SceneOp], unknown> = async (ctx, request) => {
  if (request.op === "open") {
    if (!request.module.startsWith("/")) throw new Error("scene module must be a path on the Vite server: new URL(file, import.meta.url).pathname");
    const browser = ctx.context.browser();
    if (!browser) throw new Error("scene needs a launched browser");
    const vite = ctx.project.browser?.vite;
    if (!vite) throw new Error("scene needs the browser project's Vite server");
    const origin = new URL(ctx.page.url()).origin;
    const id = `scene-${++next}`;
    const path = `/__offline_scene__/${id}`;
    // Through Vite's HTML transform, so the scene gets the same React preamble
    // as the runner's own page; its module is served like any test file.
    const html = await vite.transformIndexHtml(
      path,
      `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="scene"></div><script type="module" src="${encodeURI(request.module)}"></script></body></html>`,
    );
    const context = await browser.newContext({ reducedMotion: "reduce" });
    await context.route(`${origin}${path}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    const s = { context, url: `${origin}${path}` } as Scene;
    await attach(s, await context.newPage());
    scenes.set(id, s);
    await s.page.goto(s.url);
    await registered(s.page);
    return id;
  }
  const s = scene(request.id);
  switch (request.op) {
    case "call":
      return s.page.evaluate(
        ([action, args]) => {
          const actions = (globalThis as unknown as { __offlineScene: Record<string, (...a: unknown[]) => unknown> }).__offlineScene;
          if (typeof actions[action] !== "function") throw new Error(`scene has no action ${action}`);
          return actions[action](...args);
        },
        [request.action, request.args] as const,
      );
    case "reload":
      await s.page.reload();
      await registered(s.page);
      return null;
    case "terminate": {
      const cdp = await s.context.newCDPSession(s.page);
      const crashed = new Promise<void>((resolve) => s.page.once("crash", () => resolve()));
      // Page.crash never answers: the renderer that would answer is gone.
      void cdp.send("Page.crash").catch(() => {});
      await crashed;
      await s.page.close().catch(() => {});
      await attach(s, await s.context.newPage());
      await s.page.goto(s.url);
      await registered(s.page);
      return null;
    }
    case "close":
      scenes.delete(request.id);
      await s.context.close();
      return null;
  }
};
