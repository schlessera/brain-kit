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
  await set({ ...patch, start: true });
  ui = createBrainUiRoot({
    storage: null,
    request: async (url, init) => {
      const path = new URL(url, location.origin).pathname;
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
    test(`${theme} ${width}: actual page reload, reconnect and two devices restore one server Action`, async () => {
      await scene();
      const result = await commands.hygieneServer({ op: "native", id: fixture!.id, width, theme });
      expect(result).toMatchObject({
        sameAction: true,
        reload: true,
        reconnect: true,
        foreignReceipt: true,
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
