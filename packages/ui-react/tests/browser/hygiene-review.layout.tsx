/// <reference types="@vitest/browser-playwright" />
import { afterEach, beforeAll, afterAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { DesktopPalette } from "../../src/components/layout/desktop-palette.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";

let fixture: { id: string; url: string; scratch: string } | undefined;
let renderer: Root | undefined,
  ui: BrainUiRoot | undefined,
  host: HTMLDivElement | undefined,
  socket: WebSocket | undefined;
const frames: ClientMessage[] = [];
let reviewReads = 0, failedReads = 0;
let holdRead = false, releaseRead: (() => void) | undefined;
let styles: HTMLStyleElement;
const originalTheme = document.documentElement.dataset.theme;
const viewport = { width: innerWidth, height: innerHeight };
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(async () => {
  styles.remove();
  await page.viewport(viewport.width, viewport.height);
});
afterEach(async () => {
  releaseRead?.();
  holdRead = false; releaseRead = undefined; failedReads = 0; reviewReads = 0;
  if (renderer) flushSync(() => renderer!.unmount());
  renderer = undefined;
  ui?.dispose();
  ui = undefined;
  socket?.close();
  socket = undefined;
  host?.remove();
  host = undefined;
  if (fixture) await commands.hygieneServer({ op: "stop", id: fixture.id });
  fixture = undefined;
  frames.length = 0;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});
const settle = async () => {
  await new Promise((r) => setTimeout(r, 160));
};
const set = (patch: Record<string, unknown>) => commands.hygieneServer({ op: "set", id: fixture!.id, patch });
async function scene(patch: Record<string, unknown> = {}, width = 320, theme = "dark") {
  await page.viewport(width, 1000);
  document.documentElement.dataset.theme = theme;
  fixture = (await commands.hygieneServer({ op: "start" })) as typeof fixture;
  await set({ start: true, ...patch });
  ui = createBrainUiRoot({
    storage: null,
    request: async (url, init) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith("/hygiene/review") && (!init?.method || init.method === "GET")) {
        reviewReads++;
        if (failedReads > 0) { failedReads--; throw new Error("fixture read unavailable"); }
        if (holdRead) await new Promise<void>((resolve) => { releaseRead = resolve; });
      }
      if (path.includes("/hygiene/")) return fetch(url, init);
      if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
      if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
      return new Response("{}", { status: 404 });
    },
  });
  socket = new WebSocket(fixture!.url.replace("http:", "ws:") + "/ws");
  ui.connection.send = (msg) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    frames.push(msg);
    socket.send(JSON.stringify(msg));
    return true;
  };
  socket.onmessage = (e) => {
    const p = parseServerMessage(e.data);
    if (!p.ok) throw new Error(p.error);
    ui!.connection.handleServerMessage(p.message);
  };
  socket.onclose = () => ui?.stores.inbox.getState().connectionLost();
  await expect.poll(() => ui!.stores.inbox.getState().online).toBe(true);
  host = document.createElement("div");
  host.style.height = "1000px";
  host.style.display = "flex";
  host.className = "bg-background text-foreground";
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() =>
    renderer!.render(
      <BrainUiProvider root={ui!}>
        <ActivityPage />
        <DesktopPalette />
      </BrainUiProvider>
    )
  );
  await settle();
  if (
    width === 1280 &&
    ui.stores.inbox.getState().items &&
    Object.values(ui.stores.inbox.getState().items).some((i) => i.queue === "actions" && i.status === "pending")
  )
    await page.getByRole("button", { name: /^Open finding:/ }).click();
  return host;
}
const current = () =>
  host!.querySelector<HTMLElement>("[data-hygiene-detail] [data-hygiene-id]") ??
  host!.querySelector<HTMLElement>("[data-hygiene-id]")!;
const title = () => current().querySelector<HTMLElement>("[data-hygiene-title]")!;
async function chooseText() {
  await page.getByRole("radio", { name: "Keep the text, remove the link" }).click();
}
const apply = () => page.getByRole("button", { name: "Apply fix", exact: true }).click();
const appliedCalls = (v: unknown) =>
  (v as { calls: string[][] }).calls.filter((c) => c[0] === "resolve" && !c.includes("--dry-run"));

for (const theme of ["dark", "light"])
  for (const width of [320, 1280]) {
    test(`${theme} ${width}: failed outcomes retain the same finding and focus; never show the next card`, async () => {
      await scene({}, width, theme);
      const ax = (await commands.hygieneServer({ op: "ax", selector: '[role="radiogroup"]' })) as {
        nodes: Array<{ role?: { value: string }; name?: { value: string } }>;
      };
      const group = ax.nodes.find((node) => node.role?.value === "radiogroup");
      expect(group?.name?.value, "radio group is named in Chromium accessibility tree").toBe("Fix: broken link");
      expect(ax.nodes.filter((node) => node.role?.value === "radio").map((node) => node.name?.value)).toEqual(
        expect.arrayContaining(["Link to another note…", "Keep the text, remove the link"])
      );
      await chooseText();
      const id = current().dataset.hygieneId;
      for (const mode of ["stale", "refused", "check_failed"]) {
        await set({ mode });
        await apply();
        const focused = document.activeElement;
        await expect.poll(() => ui!.stores.inbox.getState().inFlight[id!]).toBeUndefined();
        await settle();
        expect(current()?.dataset.hygieneId, `same pending card after ${mode}`).toBe(id);
        expect(host!.textContent, `no next finding after ${mode}`).not.toContain("Another link points");
        expect(document.activeElement, `focus stays put after ${mode}`).toBe(focused);
        expect(current().textContent).toContain(
          mode === "stale" ? "This file changed" : mode === "refused" ? "Couldn't write" : "The change was written"
        );
      }
      expect(appliedCalls(await set({}))).toHaveLength(3);
      await commands.hygieneServer({
        op: "capture",
        selector: ".bg-background.text-foreground",
        name: `c5-${theme}-${width}-failure.png`,
      });
    });
    test(`${theme} ${width}: confirmed disposition focuses the next title, then Review complete`, async () => {
      await scene({}, width, theme);
      await chooseText();
      await apply();
      await expect.poll(() => current()?.textContent).toContain("Another link points");
      await expect.poll(() => document.activeElement).toBe(title());
      await chooseText();
      await apply();
      await expect.poll(() => host!.textContent).toContain("Review complete");
      await expect.poll(() => document.activeElement?.textContent).toBe("Review complete");
      expect(host!.textContent).toContain("Nothing else needs you right now.");
      expect(host!.textContent).toContain("2 fixed");
      await commands.hygieneServer({
        op: "capture",
        selector: ".bg-background.text-foreground",
        name: `c5-${theme}-${width}-complete.png`,
      });
      await page.getByRole("tab", { name: "done 2", exact: true }).click();
      expect(host!.querySelectorAll("[data-hygiene-fixed]")).toHaveLength(2);
      expect(host!.querySelector("[data-hygiene-fixed]")?.textContent).toContain("Finding no longer detected");
    });
    test(`${theme} ${width}: field input accessibility tree and typing focus`, async () => {
      await scene({ category: "required-field" }, width, theme);
      const input = page.getByRole("textbox", { name: "created (YYYY-MM-DD)" });
      await input.fill("2026-07-1");
      await page.getByRole("button", { name: "Check preview", exact: true }).click();
      await expect.poll(() => current().querySelector("input")!.getAttribute("aria-invalid")).toBe("true");
      const ax = (await commands.hygieneServer({ op: "ax", selector: "input" })) as {
        nodes: Array<{
          role?: { value: string };
          name?: { value: string };
          description?: { value: string };
          properties?: Array<{ name: string; value: { value?: unknown } }>;
        }>;
      };
      const node = ax.nodes.find((n) => n.role?.value === "textbox" && n.name?.value === "created (YYYY-MM-DD)")!;
      expect(node.description?.value, "field error is in Chromium accessibility tree").toBe(
        "Use YYYY-MM-DD, for example 2026-07-12."
      );
      const error = current().querySelector("input")!.getAttribute("aria-describedby");
      expect(document.getElementById(error!)?.textContent).toBe("Use YYYY-MM-DD, for example 2026-07-12.");
      const disabledApply = ax.nodes.find((n) => n.role?.value === "button" && n.name?.value === "Apply fix")!;
      expect(disabledApply.properties?.find((p) => p.name === "disabled")?.value.value).toBe(true);
      await input.fill("2026-07-12");
      const el = input.element();
      expect(document.activeElement, "typing never moves focus").toBe(el);
      await userEvent.keyboard("ald");
      expect(
        frames.filter((f) => f.type === "inbox_resolve"),
        "letters while typing never submit"
      ).toHaveLength(0);
      expect(document.activeElement, "typing shortcuts preserve focus").toBe(el);
    });
  }

test("refresh uses the server operation, supersedes the fingerprint card, and preserves position", async () => {
  await scene();
  await chooseText();
  await set({ mode: "stale" });
  await apply();
  await expect.poll(() => current().textContent).toContain("This file changed");
  const before = current().dataset.hygieneId;
  await set({ fingerprint: "50314b3e36cd", mode: "" });
  await page.getByRole("button", { name: "Refresh finding", exact: true }).click();
  await expect.poll(() => current()?.dataset.hygieneId).not.toBe(before);
  expect(host!.querySelector("[data-hygiene-strip]")!.textContent).toContain("1 of 2 open");
  const result = (await set({})) as { calls: string[][] };
  expect(result.calls.some((c) => c[0] === "next" && c.includes("--finding") && c.includes("--dry-run"))).toBe(true);
  expect(appliedCalls(result)).toHaveLength(1);
});
test("reload, reconnect, Pause and Resume retain the pending card and strip", async () => {
  await scene();
  const id = current().dataset.hygieneId;
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => host!.textContent).toContain("Hygiene review paused");
  expect(current().dataset.hygieneId).toBe(id);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(() => host!.querySelector("[data-hygiene-strip]")?.textContent).toContain("1 of 2 open");
  expect(current().dataset.hygieneId).toBe(id);
  flushSync(() =>
    renderer!.render(
      <BrainUiProvider root={ui!}>
        <div />
      </BrainUiProvider>
    )
  );
  flushSync(() =>
    renderer!.render(
      <BrainUiProvider root={ui!}>
        <ActivityPage />
        <DesktopPalette />
      </BrainUiProvider>
    )
  );
  ui!.stores.inbox.getState().connectionLost();
  ui!.connection.send({ type: "inbox_subscribe", view: "actions" });
  ui!.connection.send({ type: "inbox_subscribe", view: "queue" });
  await expect.poll(() => host!.querySelector("[data-hygiene-strip]")?.textContent).toContain("1 of 2 open");
  expect(current().dataset.hygieneId).toBe(id);
});
test("Undo shows a separate inverse preview and requires its own confirmation", async () => {
  await scene();
  await chooseText();
  await set({ mode: "check_failed" });
  await apply();
  await expect.poll(() => current().textContent).toContain("The change was written");
  await page.getByRole("button", { name: "Undo change", exact: true }).click();
  expect(current().textContent).toContain("Undo change · inverse preview");
  let result = (await set({})) as { calls: string[][] };
  expect(result.calls.filter((c) => c[0] === "undo" && !c.includes("--dry-run"))).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
  await expect.poll(() => current().textContent).toContain("Change undone");
  result = (await set({})) as typeof result;
  expect(result.calls.filter((c) => c[0] === "undo" && !c.includes("--dry-run"))).toHaveLength(1);
});
test("shortcuts are scoped to the card, and Later and Dismiss are confirmed separately", async () => {
  await scene();
  await chooseText();
  const needs = host!.querySelector<HTMLElement>("[data-needs-you-heading]")!;
  needs.focus();
  await userEvent.keyboard("ald");
  expect(frames.filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
  title().focus();
  await userEvent.keyboard("l");
  expect(current().textContent).toContain("Later → back at the next scheduled time");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  title().focus();
  await userEvent.keyboard("d");
  expect(current().textContent).toContain("Validation still reports it.");
  expect(frames.filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm dismiss finding", exact: true }).click();
  await expect.poll(() => current().textContent).toContain("Another link points");
});
for (const theme of ["dark", "light"])
  for (const width of [320, 1280]) {
    test(`${theme} ${width}: manual recheck remains honest`, async () => {
      await scene({ category: "manual" }, width, theme);
      await page.getByRole("button", { name: "Done, check again", exact: true }).click();
      await expect.poll(() => current().textContent).toContain("Still detected — nothing changed");
      expect(host!.textContent).not.toContain("Another link points");
    });
  }
for (const theme of ["dark", "light"])
  for (const width of [320, 1280])
    test(`${theme} ${width}: configuration blocker replaces the review; Start again retries; no open findings renders deferred counts`, async () => {
      await scene({ mode: "blocked" }, width, theme);
      await page.getByRole("tab", { name: /^needs you / }).click();
      await expect.poll(() => host!.textContent).toContain("Review can't start");
      expect(host!.querySelector("[data-hygiene-card]")).toBeNull();
      await set({ mode: "", remaining: 0 });
      await page.getByRole("button", { name: "Start again", exact: true }).click();
      await expect.poll(() => host!.textContent).toContain("No open findings.");
      expect(host!.textContent).toContain("3 informational markers not shown");
      expect(host!.textContent).toContain("Show snoozed (2)");
    });
for (const theme of ["dark", "light"])
  for (const width of [320, 1280])
    test(`${theme} ${width}: Applying locks controls, and unknown receipt checks without replaying a repair`, async () => {
      await scene({}, width, theme);
      await chooseText();
      await set({ mode: "hold" });
      await apply();
      await expect.poll(() => current().textContent).toContain("Applying… checking the file first");
      expect(current().querySelector('[data-disposition-bar] [aria-disabled="true"]')).not.toBeNull();
      await set({ mode: "unknown", release: true });
      await expect.poll(() => current().textContent).toContain("Didn't hear back.");
      await page.getByRole("button", { name: "Check again", exact: true }).click();
      await settle();
      expect(appliedCalls(await set({}))).toHaveLength(1);
    });

for (const theme of ["dark", "light"])
  for (const width of [320, 1280]) {
    test(`${theme} ${width}: actual page reload, reconnect and two devices retain local and foreign receipts`, async () => {
      await scene();
      const result = await commands.hygieneServer({ op: "native", id: fixture!.id, width, theme });
      expect(result).toMatchObject({
        sameAction: true,
        reload: true,
        reconnect: true,
        foreignReceipt: true,
        localReceipt: true,
        touch: width === 320,
      });
      expect(appliedCalls(await set({}))).toHaveLength(1);
    });
  }

test("the palette Run group starts or resumes the same hygiene review", async () => {
  await scene({}, 1280);
  const id = current().dataset.hygieneId;
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => host!.textContent).toContain("Hygiene review paused");
  ui!.stores.connection.setState({ wsStatus: "connected" } as never);
  ui!.stores.ui.getState().setPaletteOpen(true);
  await page.getByRole("combobox", { name: "Search places, questions and commands" }).fill("Start hygiene review");
  expect(ui!.stores.inbox.getState().online, "review palette uses the connected durable inbox").toBe(true);
  await page
    .getByRole("group", { name: "Run", exact: true })
    .getByRole("option", { name: /^Start hygiene review/ })
    .click();
  await expect.poll(() => host!.querySelector("[data-hygiene-strip]")?.textContent).toContain("1 of 2 open");
  expect(current().dataset.hygieneId).toBe(id);
});

test("a multiline change must be fully revealed before Apply can submit", async () => {
  await scene({ longPreview: true });
  await chooseText();
  const applyButton = page.getByRole("button", { name: "Apply fix", exact: true });
  await expect.element(page.getByRole("button", { name: /^Show all 21 lines/ })).toBeVisible();
  expect(applyButton.element().getAttribute("aria-disabled"), "hidden preview lines disable Apply").toBe("true");
  expect(frames.filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
  await page.getByRole("button", { name: /^Show all 21 lines/ }).click();
  expect(applyButton.element().getAttribute("aria-disabled")).not.toBe("true");
});

test("Later confirms the stored hygiene option and prints the server's waitUntil receipt", async () => {
  await scene();
  const id = current().dataset.hygieneId!;
  await page.getByRole("button", { name: "Later ▾", exact: true }).click();
  expect(frames.filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
  await page.getByRole("button", { name: "Snooze until the next scheduled time", exact: true }).click();
  await expect
    .poll(() => host!.querySelector("[data-hygiene-snooze-receipt]")?.textContent)
    .toContain("Snoozed · back");
  const item = ui!.stores.inbox.getState().items[id];
  expect(item?.status).toBe("snoozed");
  expect(item?.waitUntil).toBeGreaterThan(Date.UTC(2026, 6, 12, 9));
  expect(frames.filter((f) => f.type === "inbox_resolve")).toMatchObject([
    { type: "inbox_resolve", itemId: id, optionId: "later" },
  ]);
  expect(host!.querySelector("[data-hygiene-snooze-receipt]")?.textContent).toContain("Jul");
});


test("a REST read of the previous failure cannot erase the focus handoff for a confirmed recovery", async () => {
  await scene();
  await chooseText();
  await set({ mode: "unknown" });
  await apply();
  await expect.poll(() => current().textContent).toContain("Didn't hear back.");
  const before = current().dataset.hygieneId;
  await set({ mode: "check_clear" });
  const send = ui!.connection.send;
  let delayed: ClientMessage | undefined;
  // REST and the socket are separate transports. Deliver the read first,
  // holding only the lowest shared send method; the real server still checks.
  ui!.connection.send = (message) => {
    if (message.type === "inbox_resolve" && message.optionId === "check") {
      delayed = message;
      return true;
    }
    return send(message);
  };
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await settle();
  expect(current().dataset.hygieneId).toBe(before);
  expect(delayed).toBeDefined();
  ui!.connection.send = send;
  send(delayed!);
  await expect.poll(() => current()?.dataset.hygieneId).not.toBe(before);
  await expect.poll(() => document.activeElement, { message: "confirmed recovery focuses the next title" }).toBe(title());
  expect(appliedCalls(await set({}))).toHaveLength(1);
});

for (const width of [320, 1280])
  for (const completion of ["fix", "check", "dismiss", "later"] as const)
    test(`${width}: delayed final ${completion} delivers completion to both devices without reload`, async () => {
      await scene({ remaining: 1, category: completion === "check" ? "manual" : "broken-link" }, width);
      expect(await commands.hygieneServer({ op: "native", id: fixture!.id, width, theme: "dark", completion }))
        .toMatchObject({ completion, width, state: "complete", operations: 1 });
    });

for (const stop of ["pause", "offline", "unsupported", "unmount"] as const)
  test(`transient selection refresh stops on ${stop}, including an outstanding read`, async () => {
    await scene({ remaining: 1 });
    await settle();
    const idleReads = reviewReads;
    await new Promise(r => setTimeout(r, 600));
    expect(reviewReads, "waiting for a pending decision never polls").toBe(idleReads);
    await set({ holdNext: true });
    await page.getByRole("button", { name: "Later ▾", exact: true }).click();
    await page.getByRole("button", { name: "Snooze until the next scheduled time", exact: true }).click();
    await expect.poll(async () => (await set({}) as { selecting: boolean }).selecting).toBe(true);
    await settle();
    holdRead = true;
    await expect.poll(() => !!releaseRead, { message: "selection refresh started another real read" }).toBe(true);
    if (stop === "pause") await page.getByRole("button", { name: "Pause", exact: true }).click();
    else if (stop === "unmount") flushSync(() => renderer!.render(<div />));
    else ui!.stores.inbox.setState(stop === "offline" ? { online: false } : { supported: false });
    await settle();
    holdRead = false;
    releaseRead!(); releaseRead = undefined;
    await settle();
    const stoppedReads = reviewReads;
    await new Promise(r => setTimeout(r, 700));
    expect(reviewReads, `${stop} cancels selection refresh even after its read returns`).toBe(stoppedReads);
  });

test("transient selection refresh retries an unavailable REST read and stops at server completion", async () => {
  await scene({ remaining: 1 });
  await set({ holdNext: true });
  await page.getByRole("button", { name: "Later ▾", exact: true }).click();
  await page.getByRole("button", { name: "Snooze until the next scheduled time", exact: true }).click();
  await expect.poll(async () => (await set({}) as { selecting: boolean }).selecting).toBe(true);
  failedReads = 1;
  await expect.poll(() => failedReads).toBe(0);
  await set({ releaseNext: true });
  await expect.poll(() => host!.textContent, { message: "server completion arrives after a failed read" }).toContain("Review complete");
  await expect.poll(() => document.activeElement?.textContent).toBe("Review complete");
  await settle();
  const finalReads = reviewReads;
  await new Promise(r => setTimeout(r, 700));
  expect(reviewReads, "completed review stops selection refresh").toBe(finalReads);
});

test("disconnect cancels a scheduled selection read before it starts", async () => {
  await scene({ remaining: 1 });
  await set({ holdNext: true });
  await page.getByRole("button", { name: "Later ▾", exact: true }).click();
  await page.getByRole("button", { name: "Snooze until the next scheduled time", exact: true }).click();
  await expect.poll(() => host!.querySelector("[data-hygiene-id]")).toBeNull();
  // Terminal delta/REST response has committed the selecting render; its
  // first 250ms read is still scheduled. Disconnect before it starts.
  ui!.stores.inbox.setState({ online: false });
  await settle();
  const readsAtDisconnect = reviewReads;
  await new Promise(r => setTimeout(r, 600));
  expect(reviewReads, "disconnect clears the scheduled selection read").toBe(readsAtDisconnect);
});

for (const width of [320, 1280])
  test(`${width}: REST-only refreshed finding waits for replicated authority and never replays a click`, async () => {
    await scene({}, width);
    await chooseText();
    await set({ mode: "stale" });
    await apply();
    await expect.poll(() => current().textContent).toContain("This file changed");
    const oldId = current().dataset.hygieneId!;
    const receive = socket!.onmessage!;
    const held: MessageEvent[] = [];
    socket!.onmessage = event => { held.push(event); };
    try {
      await set({ fingerprint: "50314b3e36cd", mode: "" });
      await page.getByRole("button", { name: "Refresh finding", exact: true }).click();
      await expect.poll(() => [...host!.querySelectorAll<HTMLElement>("[data-hygiene-id]")]
        .some(el => el.dataset.hygieneId !== oldId)).toBe(true);
      const fresh = [...host!.querySelectorAll<HTMLElement>("[data-hygiene-id]")]
        .find(el => el.dataset.hygieneId !== oldId)!;
      const id = fresh.dataset.hygieneId!;
      expect(id, "REST returned a nonempty replacement Action identity").toBeTruthy();
      expect(ui!.stores.inbox.getState().items[id], "inbox replication is deliberately held").toBeUndefined();
      await expect.poll(() => held.length, { message: "real inbound frames are delayed" }).toBeGreaterThan(0);
      if (width === 320) {
        const later = page.getByRole("button", { name: "Later ▾", exact: true });
        expect(later.element().getAttribute("aria-disabled"), "REST-only decision controls must be unavailable").toBe("true");
        (later.element() as HTMLElement).click();
        expect(host!.querySelector("[data-hygiene-later-confirm]")).toBeNull();
        expect(page.getByRole("button", { name: "Apply fix", exact: true }).element().getAttribute("aria-disabled")).toBe("true");
        expect(page.getByRole("radio", { name: "Keep the text, remove the link" }).element()).toBeDisabled();
      } else {
        expect(page.getByRole("button", { name: /^Open finding:/ }).query(), "REST-only desktop detail entry is unavailable").toBeNull();
        await commands.hygieneServer({ op: "ax", selector: "[data-hygiene-id]" });
        expect(host!.textContent, "REST-only replacement never opens an absent terminal decision")
          .not.toContain("This decision is no longer listed");
        expect(host!.querySelector("[data-hygiene-detail] [data-hygiene-id]")?.getAttribute("data-hygiene-id"))
          .toBe(oldId);
        await page.getByRole("button", { name: "Back to Actions", exact: true }).click();
        expect(page.getByRole("button", { name: /^Open finding:/ }).query(), "REST-only desktop detail entry is unavailable").toBeNull();
      }
      expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id), "no response is queued for replay").toHaveLength(0);
      await commands.hygieneServer({ op: "capture", selector: ".bg-background.text-foreground", name: `replication-wait-${width}.png` });
      socket!.onmessage = receive;
      for (const event of held.splice(0)) receive.call(socket!, event);
      await expect.poll(() => ui!.stores.inbox.getState().items[id]?.status).toBe("pending");
      if (width === 1280) await page.getByRole("button", { name: /^Open finding:/ }).click();
      await expect.poll(() => current().dataset.hygieneId).toBe(id);
      await chooseText();
      expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id), "delivery alone never applies a repair").toHaveLength(0);
      await apply();
      await expect.poll(() => {
        const item = ui!.stores.inbox.getState().items[id];
        return item?.queue === "actions" ? item.hygiene?.outcome?.status : undefined;
      }).toBe("fixed");
      expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id)).toHaveLength(1);
      expect(appliedCalls(await set({})), "one old stale attempt and exactly one explicit replacement repair").toHaveLength(2);
    } finally {
      socket!.onmessage = receive;
      for (const event of held) receive.call(socket!, event);
    }
  });

for (const width of [320, 1280])
  for (const operation of ["start", "resume"] as const)
    test(`${width}: REST-only ${operation} keeps manual and disposition controls unavailable until replication`, async () => {
      await scene({ start: false, category: "manual" }, width);
      await page.getByRole("tab", { name: /^needs you / }).click();
      const receive = socket!.onmessage!;
      const held: MessageEvent[] = [];
      socket!.onmessage = event => { held.push(event); };
      try {
        await page.getByRole("button", { name: "Start hygiene review", exact: true }).click();
        await expect.poll(() => current()?.dataset.hygieneId).toBeTruthy();
        const id = current().dataset.hygieneId!;
        if (operation === "resume") {
          await page.getByRole("button", { name: "Pause", exact: true }).click();
          await expect.poll(() => host!.textContent).toContain("Hygiene review paused");
          await page.getByRole("button", { name: "Resume", exact: true }).click();
          await expect.poll(() => host!.querySelector("[data-hygiene-strip]")?.textContent).toContain("1 of 2 open");
          expect(current().dataset.hygieneId, "Resume retains the same REST-only pending Action").toBe(id);
        }
        expect(ui!.stores.inbox.getState().items[id]).toBeUndefined();
        await expect.poll(() => held.length).toBeGreaterThan(0);
        if (width === 320) {
          for (const name of ["Done, check again", "Later ▾", "Dismiss"]) {
            const button = page.getByRole("button", { name, exact: true }).element() as HTMLElement;
            expect(button.getAttribute("aria-disabled"), `${name} waits for replication`).toBe("true");
            button.click();
          }
          title().focus();
          await userEvent.keyboard("ald");
          expect(host!.querySelector("[data-hygiene-later-confirm], [data-hygiene-dismiss-confirm]")).toBeNull();
        } else {
          expect(page.getByRole("button", { name: /^Open finding:/ }).query()).toBeNull();
        }
        expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id)).toHaveLength(0);
        socket!.onmessage = receive;
        for (const event of held.splice(0)) receive.call(socket!, event);
        await expect.poll(() => ui!.stores.inbox.getState().items[id]?.status).toBe("pending");
        if (width === 1280) await page.getByRole("button", { name: /^Open finding:/ }).click();
        expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id), "replication never replays disabled controls").toHaveLength(0);
        if (operation === "start") {
          await page.getByRole("button", { name: "Done, check again", exact: true }).click();
          await expect.poll(() => current().textContent).toContain("Still detected — nothing changed");
        } else {
          await page.getByRole("button", { name: "Dismiss", exact: true }).click();
          await page.getByRole("button", { name: "Confirm dismiss finding", exact: true }).click();
          await expect.poll(() => ui!.stores.inbox.getState().items[id]?.status).toBe("dismissed");
        }
        expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id)).toHaveLength(1);
      } finally {
        socket!.onmessage = receive;
        for (const event of held) receive.call(socket!, event);
      }
    });

for (const recovery of ["unknown", "undo"] as const)
  test(`REST-only ${recovery} recovery waits for replicated authority`, async () => {
    await scene({ start: false });
    await page.getByRole("tab", { name: /^needs you / }).click();
    const receive = socket!.onmessage!;
    const held: MessageEvent[] = [];
    socket!.onmessage = event => { held.push(event); };
    try {
      await page.getByRole("button", { name: "Start hygiene review", exact: true }).click();
      await expect.poll(() => current()?.dataset.hygieneId).toBeTruthy();
      const id = current().dataset.hygieneId!;
      expect(ui!.stores.inbox.getState().items[id]).toBeUndefined();
      // Another explicit server response can settle before this device receives
      // the Action. Hold only inbound frames; the real dispatcher still applies.
      await set({ mode: recovery === "unknown" ? "unknown" : "check_failed" });
      socket!.send(JSON.stringify({ type: "inbox_resolve", itemId: id, optionId: "link-text", input: null }));
      await expect.poll(async () => (await ui!.api.hygieneReview()).action?.hygiene?.outcome?.status).toBe("check_failed");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect.poll(() => host!.textContent).toContain("Hygiene review paused");
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      const label = recovery === "unknown" ? "Check again" : "Undo change";
      const button = page.getByRole("button", { name: label, exact: true });
      await expect.element(button).toBeVisible();
      expect((button.element() as HTMLButtonElement).disabled, `${label} waits for replicated authority`).toBe(true);
      (button.element() as HTMLButtonElement).click();
      expect(host!.querySelector("[data-hygiene-id]")?.textContent).not.toContain("Undo change · inverse preview");
      expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id)).toHaveLength(0);
      await expect.poll(() => held.length).toBeGreaterThan(0);
      socket!.onmessage = receive;
      for (const event of held.splice(0)) receive.call(socket!, event);
      await expect.poll(() => ui!.stores.inbox.getState().items[id]?.version).toBeGreaterThan(1);
      await expect.element(button).toBeEnabled();
      expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id), "receipt delivery does not confirm recovery").toHaveLength(0);
      if (recovery === "unknown") {
        await set({ mode: "check_clear" });
        await button.click();
        await expect.poll(() => ui!.stores.inbox.getState().items[id]?.status).toBe("resolved");
      } else {
        await button.click();
        await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
        await expect.poll(() => current().textContent).toContain("Change undone");
      }
      expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id)).toHaveLength(1);
      expect(appliedCalls(await set({})), "recovery never repeats the original repair").toHaveLength(1);
    } finally {
      socket!.onmessage = receive;
      for (const event of held) receive.call(socket!, event);
    }
  });
