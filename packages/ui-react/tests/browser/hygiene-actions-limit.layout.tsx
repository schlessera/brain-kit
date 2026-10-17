/// <reference types="@vitest/browser-playwright" />
import { afterEach, beforeAll, afterAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import type { HygieneReviewRead } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";

let fixture: { id: string; url: string } | undefined;
let renderer: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined, socket: WebSocket | undefined;
let styles: HTMLStyleElement;
let release: (() => void) | undefined;
let holdResume = false, failResume = false, sameReceipt = false, resumeRequests = 0;
const originalTheme = document.documentElement.dataset.theme;
const viewport = { width: innerWidth, height: innerHeight };
let outer: { width: number; height: number } | undefined;
const requests = new Set<Promise<Response>>();
const resumeName = "Resume hygiene review: bring back the set-aside finding";
const panel = () => host!.querySelector<HTMLElement>("[data-hygiene-limit]");
const set = (patch: Record<string, unknown>) => commands.hygieneServer({ op: "set", id: fixture!.id, patch }) as Promise<{ read: HygieneReviewRead }>;

beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
afterEach(async () => {
  release?.(); release = undefined;
  if (renderer) flushSync(() => renderer!.unmount());
  renderer = undefined;
  ui?.dispose(); ui = undefined;
  socket?.close(); socket = undefined;
  host?.remove(); host = undefined;
  await Promise.allSettled([...requests]);
  if (fixture) await commands.hygieneServer({ op: "stop", id: fixture.id });
  fixture = undefined;
  holdResume = false; failResume = false; sameReceipt = false; resumeRequests = 0;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  outer = undefined;
});
async function scene(width = 320, theme = "dark") {
  outer = await commands.formViewport(width, 1000);
  await page.viewport(width, 1000);
  document.documentElement.dataset.theme = theme;
  fixture = await commands.hygieneServer({ op: "start" }) as typeof fixture;
  await set({ start: true });
  ui = createBrainUiRoot({ storage: null, request: (url, init) => {
    const request = (async () => {
    const path = new URL(url, location.origin).pathname;
    if (path.endsWith("/hygiene/review") && init?.method === "POST" && JSON.parse(String(init?.body)).operation === "resume") {
      resumeRequests++;
      if (holdResume) await new Promise<void>(resolve => { release = resolve; });
      if (failResume) throw new Error("fixture connection unavailable");
      // A real authoritative read with the same receipt models a server that
      // cannot re-admit yet; no client selection or fabricated Action is used.
      if (sameReceipt) return fetch(url);
    }
    if (path.includes("/hygiene/")) return fetch(url, init);
    if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
    if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
    return new Response("{}", { status: 404 });
    })();
    requests.add(request);
    void request.finally(() => requests.delete(request)).catch(() => {});
    return request;
  } });
  socket = new WebSocket(fixture!.url.replace("http:", "ws:") + "/ws");
  ui.connection.send = msg => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(msg)); return true;
  };
  socket.onmessage = event => {
    const parsed = parseServerMessage(event.data);
    if (!parsed.ok) throw new Error(parsed.error);
    ui!.connection.handleServerMessage(parsed.message);
  };
  socket.onclose = () => ui?.stores.inbox.getState().connectionLost();
  await expect.poll(() => ui!.stores.inbox.getState().online).toBe(true);
  host = document.createElement("div");
  host.style.cssText = "height:1000px;display:flex";
  host.className = "bg-background text-foreground";
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}><ActivityPage /></BrainUiProvider>));
  await expect.poll(() => host!.querySelector("[data-hygiene-id]")).not.toBeNull();
}
async function fill(longFinding = false) {
  const result = await set({ longFinding, fillActions: true });
  expect(result.read.review.pendingActionId, "cap clears the authoritative pointer").toBeUndefined();
  expect(result.read.action).toBeNull();
  const reason = result.read.review.pauseReason!;
  // Filling commits on the server before the browser drains the Action burst.
  // Start the presentation deadline only after the real retirement reaches it.
  await expect.poll(() => ui!.stores.inbox.getState().items[reason.retiredActionId]?.status,
    { message: "cap retirement reaches the browser" }).toBe("dropped");
  await expect.poll(() => panel()?.dataset.hygieneLimit).toBe("L1");
  await expect.poll(() => host!.querySelector("[data-hygiene-id]"), { message: "retirement clears the visible finding" }).toBeNull();
  return reason;
}
function noCard() {
  expect(host!.querySelector("[data-hygiene-id]"), "retirement renders no hygiene card").toBeNull();
  expect(host!.textContent, "Needs you has no duplicate generic dropped row").not.toContain("Dropped at the cap");
}
function noIds(reason: NonNullable<HygieneReviewRead["review"]["pauseReason"]>) {
  expect(panel()!.textContent).not.toContain(reason.retiredActionId);
  expect(panel()!.textContent).not.toContain(reason.retirementReceiptId);
  expect(panel()!.textContent, "the panel is number-free").not.toContain("60");
}

for (const theme of ["dark", "light"])
  for (const width of [320, 1280]) {
    test(`${theme} ${width}: Actions-limit P0 L1 L3`, async () => {
      await scene(width, theme);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect.poll(() => host!.querySelector("[data-hygiene-strip], [data-hygiene-limit]")?.textContent, { message: "P0 retains exactly the deliberate pause copy" }).toBe("Hygiene review pausedResume");
      expect(panel(), "P0 never renders the Actions-limit explanation").toBeNull();
      await page.getByRole("button", { name: "Resume hygiene review", exact: true }).click();
      await expect.poll(() => host!.querySelector("[data-hygiene-strip]")?.textContent).toContain("1 of 2 open");
      const reason = await fill();
      noCard(); noIds(reason);
      expect(panel()!.textContent).toContain("Newer decisions filled Actions, so the current finding was set aside. Nothing was fixed, dismissed or snoozed.");
      expect(panel()!.textContent).toContain("Set aside: A link points to a note that does not exist · journeys/return-to-ithaca.md");
      expect(panel()!.getAttribute("role")).toBe("status");
      const list = host!.querySelector("[data-decision-list]")!;
      expect(panel()!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING, "panel sits above the decisions below").toBeTruthy();
      const button = page.getByRole("button", { name: resumeName, exact: true });
      expect(button.element().getBoundingClientRect().height, "Resume has a 44px target").toBeGreaterThanOrEqual(44);
      await expect(page.elementLocator(panel()!)).toMatchScreenshot(`actions-limit-L1-${theme}-${width}`);
      const ax = await commands.hygieneServer({ op: "ax", selector: "[data-hygiene-limit]" }) as { nodes: Array<{ role?: { value: string }; name?: { value: string } }> };
      expect(ax.nodes.some(n => n.role?.value === "button" && n.name?.value === resumeName)).toBe(true);
      expect(getComputedStyle(panel()!).animationName, "reduced-motion panel has no animation").toBe("none");

      sameReceipt = true;
      await button.click();
      await expect.poll(() => (button.element() as HTMLButtonElement).disabled).toBe(false);
      expect(panel()!.dataset.hygieneLimit, "unchanged receipt must remain L1").toBe("L1");
      sameReceipt = false;
      await button.click();
      await expect.poll(() => panel()?.dataset.hygieneLimit).toBe("L3");
      expect(panel()!.textContent).toContain("Still paused · Actions is still full");
      expect(panel()!.textContent).toContain("Resume brought the finding back, but it was set aside again straight away. Answer or dismiss a few decisions below, then resume.");
      await expect.poll(() => document.activeElement, { message: "L3 retains Resume focus" }).toBe(button.element());
      noCard(); noIds((await set({})).read.review.pauseReason!);
      const skin = panel()!.firstElementChild as HTMLElement;
      const expected = document.createElement("div");
      expected.style.borderColor = "var(--bk-callout-border-gold)"; host!.append(expected);
      expect(getComputedStyle(skin).borderColor, "L3 uses the kit gold border").toBe(getComputedStyle(expected).borderColor);
      expected.remove();
      await expect(page.elementLocator(panel()!)).toMatchScreenshot(`actions-limit-L3-${theme}-${width}`);
    });
    test(`${theme} ${width}: Resume waits for server confirmation then focuses L2`, async () => {
      await scene(width, theme);
      await fill();
      await set({ makeRoom: true });
      const button = page.getByRole("button", { name: resumeName, exact: true });
      holdResume = true;
      // Tab away and back using the browser's keyboard, then activate with Enter.
      (button.element() as HTMLElement).focus();
      await userEvent.keyboard("{Tab}{Shift>}{Tab}{/Shift}{Enter}");
      await expect.poll(() => !!release).toBe(true);
      expect(panel()?.dataset.hygieneLimit, "click cannot advance before the read").toBe("L1");
      expect(button.element().textContent).toBe("Resuming…");
      expect((button.element() as HTMLButtonElement).disabled).toBe(true);
      noCard();
      holdResume = false; release!(); release = undefined;
      await expect.poll(() => panel()).toBeNull();
      await expect.poll(() => document.activeElement?.hasAttribute("data-hygiene-title"), { message: "server-confirmed Resume focuses the finding title" }).toBe(true);
      expect((await set({})).read.review.status).toBe("active");
      expect(Object.values(ui!.stores.inbox.getState().items).filter(i => i.queue === "actions" && i.hygiene && i.status === "pending")).toHaveLength(1);
    });
  }

test("Resume request failure retains L1 and Try again above it; long metadata wraps at 320", async () => {
  await scene();
  await fill(true);
  const p = panel()!;
  expect(p.textContent).toContain("Broken link to [[Aeolus]]");
  expect(p.scrollWidth, "long title/path does not overflow").toBeLessThanOrEqual(p.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  failResume = true;
  await page.getByRole("button", { name: resumeName, exact: true }).click();
  await expect.poll(() => host!.textContent).toContain("Couldn't load the review. Check the connection and try again.");
  expect(panel()).toBe(p); expect(panel()!.dataset.hygieneLimit).toBe("L1"); noCard();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  expect(retry.element().compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.activeElement).toBe(page.getByRole("button", { name: resumeName, exact: true }).element());
  await retry.click();
  expect(resumeRequests, "Try again does not automatically resume").toBe(1);
});

for (const width of [320, 1280]) test(`${width}: confirmed Resume never steals editable focus and missing retired metadata is omitted`, async () => {
  await scene(width);
  const reason = await fill();
  const stored = ui!.stores.inbox.getState().items;
  ui!.stores.inbox.setState({ items: Object.fromEntries(Object.entries(stored).filter(([id]) => id !== reason.retiredActionId)) });
  await expect.poll(() => panel()!.textContent, { message: "missing retired metadata is omitted" }).not.toContain("Set aside:");
  expect(host!.querySelector(`[data-decision-receipt="${CSS.escape(reason.retiredActionId)}"]`),
    "paused retirement has no duplicate row even without its cached Action").toBeNull();
  await set({ makeRoom: true });
  holdResume = true;
  await page.getByRole("button", { name: resumeName, exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  const input = document.createElement("input"); host!.append(input); input.focus();
  holdResume = false; release!(); release = undefined;
  await expect.poll(() => panel()).toBeNull();
  await expect.poll(() => host!.querySelector("[data-hygiene-id]")).not.toBeNull();
  const admitted = (await set({})).read.action!;
  await expect.poll(() => ui!.stores.inbox.getState().items[admitted.id]?.status).toBe("pending");
  await expect.poll(() => requests.size).toBe(0);
  // Observe focus after the confirmed replicated render and its passive effects,
  // rather than accepting the input's focus before the handoff has run.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(document.activeElement, "confirmed Resume preserves editable focus").toBe(input);
});


test("desktop Resume focus waits for the current Action stream", async () => {
  await scene(1280);
  await fill();
  await set({ makeRoom: true });
  const receive = socket!.onmessage!;
  const held: MessageEvent[] = [];
  socket!.onmessage = event => { held.push(event); };
  try {
    await page.getByRole("button", { name: resumeName, exact: true }).click();
    await expect.poll(() => panel()).toBeNull();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    expect(document.activeElement?.hasAttribute("data-hygiene-title"), "REST-only admission cannot focus absent replicated detail").toBe(false);
    expect(host!.querySelector("[data-hygiene-detail] [data-hygiene-id]")).toBeNull();
    socket!.onmessage = receive;
    for (const event of held.splice(0)) receive.call(socket!, event);
    await expect.poll(() => document.activeElement?.hasAttribute("data-hygiene-title"), { message: "replicated Resume delivers exactly one focus handoff" }).toBe(true);
    expect(host!.querySelectorAll("[data-hygiene-detail] [data-hygiene-id]")).toHaveLength(1);
  } finally {
    socket!.onmessage = receive;
    for (const event of held) receive.call(socket!, event);
  }
});


test("the limit presentation preserves the stored receipt and its Done note", async () => {
  await scene();
  const reason = await fill();
  const receipt = ui!.stores.inbox.getState().items[reason.retirementReceiptId];
  expect(receipt?.queue).toBe("actions");
  expect(receipt?.type).toBe("fyi");
  await page.getByRole("tab", { name: /^done / }).click();
  await expect.poll(() => host!.textContent).toContain("A decision was dropped at the Actions limit");
  expect(ui!.stores.inbox.getState().items[reason.retirementReceiptId]).toEqual(receipt);
  expect((await set({})).read.review.pauseReason).toEqual(reason);
  await page.getByRole("tab", { name: /^needs you / }).click();
  await expect.poll(() => panel()?.dataset.hygieneLimit).toBe("L1");
  noCard();
});


for (const theme of ["dark", "light"])
  for (const width of [320, 1280])
    test(`${theme} ${width}: native page reload resets L3 to L1 and retains L2`, async () => {
      fixture = await commands.hygieneServer({ op: "start" }) as typeof fixture;
      await set({ start: true });
      await set({ fillActions: true });
      expect(await commands.hygieneServer({ op: "native", id: fixture!.id, width, theme, limitReload: "both" }))
        .toMatchObject({ reload: "L1/L2", localRepeat: "L3" });
    });
