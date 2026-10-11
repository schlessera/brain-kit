// The worker host notice (#1632) on the mounted Composer, in real Chromium
// with the consumer styles: it sits above the field inside the composer's
// column at phone and desktop widths in both themes, wraps a long probe
// requirement without overflowing, keeps a 44px "Check again" target, and
// leaves the composer usable. No network: the root's fixture transport
// answers /api/status and the re-check.
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ClientMessage, WorkerHostStatus } from "@schlessera/brain-ui-sdk/protocol";
import { Composer } from "../../src/components/chat/composer.js";
import { WORKER_HOST_DOCS_URL } from "../../src/components/chat/worker-host-notice.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";

// The probe's longest named requirement: the fresh-/proc refusal with
// bubblewrap's own words after it.
const REQUIREMENT = "the kernel refused the worker a fresh /proc because the parent /proc has masked or covered paths;"
  + " in Docker, run the container with --security-opt systempaths=unconfined"
  + " (bwrap: Can't mount proc on /newroot/proc: Operation not permitted)";
const DOWN: WorkerHostStatus = { ordinary: { available: false, requirement: REQUIREMENT, checkedAt: "2026-07-12T08:00:00.000Z", trigger: "boot" } };
const UP: WorkerHostStatus = { ordinary: { available: true, checkedAt: "2026-07-12T08:05:00.000Z", trigger: "check" } };

let styles: HTMLStyleElement;
let scene: { host: HTMLDivElement; renderer: Root; root: BrainUiRoot } | undefined;
let frame: { width: number; height: number } | undefined;
let previousTheme: string | null = null;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterEach(async () => {
  if (scene) { flushSync(() => scene!.renderer.unmount()); scene.root.dispose(); scene.host.remove(); }
  scene = undefined;
  if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", previousTheme);
  if (frame) await page.viewport(frame.width, frame.height);
});
afterAll(() => styles.remove());

async function mount(width: number, theme: "light" | "dark") {
  frame = { width: innerWidth, height: innerHeight };
  await page.viewport(width, 800);
  previousTheme = document.documentElement.getAttribute("data-theme");
  document.documentElement.dataset.theme = theme;
  const checks: string[] = [];
  const root = createBrainUiRoot({ storage: null, request: async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/status/worker-host")) { checks.push(init?.method ?? "GET"); return Response.json(UP); }
    if (url.endsWith("/api/status")) return Response.json({ healthy: true, runtime: { boot: [], workerHost: DOWN } });
    return Response.json({ providers: [], backends: {} });
  } });
  root.stores.ui.setState({ theme });
  root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: true });
  root.stores.chat.getState().setActiveSession("odysseus-ogygia");
  root.stores.chat.getState().setMessages("odysseus-ogygia", []);
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:0;bottom:0;width:${width}px`;
  document.body.append(host);
  const renderer = createRoot(host);
  const frames: ClientMessage[] = [];
  scene = { host, renderer, root };
  flushSync(() => renderer.render(<BrainUiProvider root={root}><Composer send={msg => { frames.push(msg); return true; }} /></BrainUiProvider>));
  return { host, frames, checks };
}

for (const width of [320, 1280]) for (const theme of ["light", "dark"] as const) {
  test(`${width} ${theme}: the notice sits above a usable composer and clears on Check again`, async () => {
    const { host, frames, checks } = await mount(width, theme);
    await expect.poll(() => host.querySelector("[data-worker-host-notice]")).not.toBeNull();
    const notice = host.querySelector<HTMLElement>("[data-worker-host-notice]")!;
    const composer = host.querySelector<HTMLElement>("[data-composer]")!;
    const box = notice.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    expect(box.bottom).toBeLessThanOrEqual(composer.getBoundingClientRect().top);
    expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth + 1);
    expect(notice.querySelector("[data-worker-host-requirement]")!.textContent).toBe(REQUIREMENT);
    const link = notice.querySelector<HTMLAnchorElement>("a")!;
    expect(link.href).toBe(WORKER_HOST_DOCS_URL);
    expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(box.right);
    const check = page.getByRole("button", { name: "Check again" });
    const target = check.element().getBoundingClientRect();
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.right).toBeLessThanOrEqual(width);

    // The composer still sends: the server, not the notice, refuses the turn.
    await userEvent.fill(page.getByRole("textbox"), "Where is Ithaca?");
    await userEvent.click(page.getByRole("button", { name: "Send" }));
    await expect.poll(() => frames.some(f => f.type === "chat_message")).toBe(true);

    await userEvent.click(check);
    await expect.poll(() => host.querySelector("[data-worker-host-notice]")).toBeNull();
    expect(checks).toEqual(["POST"]);
  });
}
