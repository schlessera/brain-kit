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
function createResumeState() {
  return {
    release: undefined as (() => void) | undefined,
    holdResume: false, failResume: false, sameReceipt: false, resumeRequests: 0,
    requests: new Set<Promise<Response>>(),
  };
}
let resume = createResumeState();
const originalTheme = document.documentElement.dataset.theme;
const viewport = { width: innerWidth, height: innerHeight };
let outer: { width: number; height: number } | undefined;
const resumeName = "Resume hygiene review: bring back the set-aside finding";
const panel = () => host!.querySelector<HTMLElement>("[data-hygiene-limit]");
const set = (patch: Record<string, unknown>) => commands.hygieneServer({ op: "set", id: fixture!.id, patch }) as Promise<{ read: HygieneReviewRead }>;

beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
async function disposeScene() {
  const sceneRenderer = renderer, sceneUi = ui, sceneSocket = socket, sceneHost = host, sceneFixture = fixture;
  const sceneResume = resume;
  renderer = undefined; ui = undefined; socket = undefined; host = undefined; fixture = undefined;
  resume = createResumeState();
  sceneResume.release?.(); sceneResume.release = undefined;
  if (sceneRenderer) flushSync(() => sceneRenderer.unmount());
  sceneUi?.dispose();
  sceneSocket?.close();
  sceneHost?.remove();
  await Promise.allSettled([...sceneResume.requests]);
  if (sceneFixture) await commands.hygieneServer({ op: "stop", id: sceneFixture.id });
}
afterEach(async () => {
  await disposeScene();
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
  const sceneFixture = fixture = await commands.hygieneServer({ op: "start" }) as NonNullable<typeof fixture>;
  await commands.hygieneServer({ op: "set", id: sceneFixture.id, patch: { start: true } });
  const sceneResume = resume = createResumeState();
  const sceneUi = ui = createBrainUiRoot({ storage: null, request: (url, init) => {
    const request = (async () => {
    const path = new URL(url, location.origin).pathname;
    if (path.endsWith("/hygiene/review") && init?.method === "POST" && JSON.parse(String(init?.body)).operation === "resume") {
      sceneResume.resumeRequests++;
      if (sceneResume.holdResume) await new Promise<void>(resolve => { sceneResume.release = resolve; });
      if (sceneResume.failResume) throw new Error("fixture connection unavailable");
      // A real authoritative read with the same receipt models a server that
      // cannot re-admit yet; no client selection or fabricated Action is used.
      if (sceneResume.sameReceipt) return fetch(url);
    }
    if (path.includes("/hygiene/")) return fetch(url, init);
    if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
    if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
    return new Response("{}", { status: 404 });
    })();
    sceneResume.requests.add(request);
    void request.finally(() => sceneResume.requests.delete(request)).catch(() => {});
    return request;
  } });
  const sceneSocket = socket = new WebSocket(sceneFixture.url.replace("http:", "ws:") + "/ws");
  sceneUi.connection.send = msg => {
    if (sceneSocket.readyState !== WebSocket.OPEN) return false;
    sceneSocket.send(JSON.stringify(msg)); return true;
  };
  sceneSocket.onmessage = event => {
    const parsed = parseServerMessage(event.data);
    if (!parsed.ok) throw new Error(parsed.error);
    sceneUi.connection.handleServerMessage(parsed.message);
  };
  // Late close only marks the disposed owner offline; its connection ignores late frames.
  sceneSocket.onclose = () => sceneUi.stores.inbox.getState().connectionLost();
  await expect.poll(() => sceneUi.stores.inbox.getState().online).toBe(true);
  const sceneHost = host = document.createElement("div");
  sceneHost.style.cssText = "height:1000px;display:flex";
  sceneHost.className = "bg-background text-foreground";
  document.body.append(sceneHost);
  const sceneRenderer = renderer = createRoot(sceneHost);
  flushSync(() => sceneRenderer.render(<BrainUiProvider root={sceneUi}><ActivityPage /></BrainUiProvider>));
  await expect.poll(() => sceneHost.querySelector("[data-hygiene-id]")).not.toBeNull();
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

test("a disposed Actions-limit scene's held real close cannot take its replacement offline", async () => {
  await scene();
  const previousSocket = socket!;
  const close = previousSocket.onclose!;
  let heldClose: CloseEvent | undefined;
  previousSocket.onclose = event => { heldClose = event; };
  await disposeScene();
  await expect.poll(() => heldClose, { message: "the previous Actions-limit socket's real close is held" }).toBeDefined();
  expect(heldClose!.target).toBe(previousSocket);
  expect(previousSocket.readyState).toBe(WebSocket.CLOSED);
  await scene();
  const nextUi = ui!, nextSocket = socket!;
  await Promise.resolve().then(() => close.call(previousSocket, heldClose!));
  expect(nextSocket.readyState, "the replacement Actions-limit socket stays open").toBe(WebSocket.OPEN);
  await expect.poll(() => nextUi.stores.inbox.getState().online, {
    message: "the replacement Actions-limit scene stays online after the old real close",
  }).toBe(true);
});

test("a disposed Actions-limit scene's held real snapshot cannot change its replacement inbox", async () => {
  await scene();
  const previousSocket = socket!, previousUi = ui!;
  const receive = previousSocket.onmessage!;
  let heldSnapshot: MessageEvent | undefined;
  previousSocket.onmessage = event => {
    const parsed = parseServerMessage(event.data);
    if (parsed.ok && parsed.message.type === "inbox_snapshot" && parsed.message.items.length > 0) heldSnapshot = event;
    else receive.call(previousSocket, event);
  };
  previousUi.connection.send({ type: "inbox_subscribe", view: "actions" });
  await expect.poll(() => heldSnapshot, { message: "the previous Actions-limit socket's real snapshot is held" }).toBeDefined();
  expect(heldSnapshot!.target).toBe(previousSocket);
  await disposeScene();
  await scene();
  const nextUi = ui!;
  const before = nextUi.stores.inbox.getState().items;
  await Promise.resolve().then(() => receive.call(previousSocket, heldSnapshot!));
  expect(nextUi.stores.inbox.getState().items, "the old real snapshot leaves the replacement Actions-limit inbox untouched").toBe(before);
});

test("a disposed Actions-limit scene's sender cannot use its replacement socket", async () => {
  await scene();
  const send = ui!.connection.send;
  await disposeScene();
  await scene();
  expect(socket!.readyState).toBe(WebSocket.OPEN);
  expect(send({ type: "inbox_subscribe", view: "actions" }), "the old Actions-limit sender refuses its closed socket").toBe(false);
});

test("a disposed Actions-limit request retains its original controls and tracking", async () => {
  await scene();
  const request = ui!.request, previousResume = resume;
  await disposeScene();
  await scene();
  previousResume.holdResume = true; previousResume.failResume = true;
  const result = request("/api/hygiene/review", { method: "POST", body: JSON.stringify({ operation: "resume" }) });
  try {
    expect(resume.resumeRequests, "the old request cannot increment the replacement Resume counter").toBe(0);
    expect(resume.requests.size, "the old request cannot join replacement request tracking").toBe(0);
    expect(resume.release, "the old request cannot borrow the replacement Resume resolver").toBeUndefined();
    expect(previousResume.release).toBeTypeOf("function");
    previousResume.release!();
    await expect(result).rejects.toThrow("fixture connection unavailable");
    expect(previousResume.resumeRequests).toBe(1);
    await expect.poll(() => previousResume.requests.size, { message: "old request settlement clears only its own tracking" }).toBe(0);
  } finally { previousResume.release?.(); resume.release?.(); await Promise.allSettled([result]); }
});

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

      resume.sameReceipt = true;
      await button.click();
      await expect.poll(() => (button.element() as HTMLButtonElement).disabled).toBe(false);
      expect(panel()!.dataset.hygieneLimit, "unchanged receipt must remain L1").toBe("L1");
      resume.sameReceipt = false;
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
      resume.holdResume = true;
      // Tab away and back using the browser's keyboard, then activate with Enter.
      (button.element() as HTMLElement).focus();
      await userEvent.keyboard("{Tab}{Shift>}{Tab}{/Shift}{Enter}");
      await expect.poll(() => !!resume.release).toBe(true);
      expect(panel()?.dataset.hygieneLimit, "click cannot advance before the read").toBe("L1");
      expect(button.element().textContent).toBe("Resuming…");
      expect((button.element() as HTMLButtonElement).disabled).toBe(true);
      noCard();
      resume.holdResume = false; resume.release!(); resume.release = undefined;
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
  resume.failResume = true;
  await page.getByRole("button", { name: resumeName, exact: true }).click();
  await expect.poll(() => host!.textContent).toContain("Couldn't load the review. Check the connection and try again.");
  expect(panel()).toBe(p); expect(panel()!.dataset.hygieneLimit).toBe("L1"); noCard();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  expect(retry.element().compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.activeElement).toBe(page.getByRole("button", { name: resumeName, exact: true }).element());
  await retry.click();
  expect(resume.resumeRequests, "Try again does not automatically resume").toBe(1);
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
  resume.holdResume = true;
  await page.getByRole("button", { name: resumeName, exact: true }).click();
  await expect.poll(() => !!resume.release).toBe(true);
  const input = document.createElement("input"); host!.append(input); input.focus();
  resume.holdResume = false; resume.release!(); resume.release = undefined;
  await expect.poll(() => panel()).toBeNull();
  await expect.poll(() => host!.querySelector("[data-hygiene-id]")).not.toBeNull();
  const admitted = (await set({})).read.action!;
  await expect.poll(() => ui!.stores.inbox.getState().items[admitted.id]?.status).toBe("pending");
  await expect.poll(() => resume.requests.size).toBe(0);
  // Observe focus after the confirmed replicated render and its passive effects,
  // rather than accepting the input's focus before the handoff has run.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(document.activeElement, "confirmed Resume preserves editable focus").toBe(input);
});


test("desktop Resume focus waits for the current Action stream", async () => {
  await scene(1280);
  await fill();
  await set({ makeRoom: true });
  const sceneSocket = socket!;
  const receive = sceneSocket.onmessage!;
  const held: MessageEvent[] = [];
  sceneSocket.onmessage = event => { held.push(event); };
  try {
    await page.getByRole("button", { name: resumeName, exact: true }).click();
    await expect.poll(() => panel()).toBeNull();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    expect(document.activeElement?.hasAttribute("data-hygiene-title"), "REST-only admission cannot focus absent replicated detail").toBe(false);
    expect(host!.querySelector("[data-hygiene-detail] [data-hygiene-id]")).toBeNull();
    sceneSocket.onmessage = receive;
    for (const event of held.splice(0)) receive.call(sceneSocket, event);
    await expect.poll(() => document.activeElement?.hasAttribute("data-hygiene-title"), { message: "replicated Resume delivers exactly one focus handoff" }).toBe(true);
    expect(host!.querySelectorAll("[data-hygiene-detail] [data-hygiene-id]")).toHaveLength(1);
  } finally {
    sceneSocket.onmessage = receive;
    for (const event of held) receive.call(sceneSocket, event);
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
