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
function createReadState() {
  return {
    reviewReads: 0,
    failedReads: 0,
    holdRead: false,
    releaseRead: undefined as (() => void) | undefined,
    detailsOffline: false,
  };
}
let reads = createReadState();
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
async function disposeScene() {
  const sceneRenderer = renderer, sceneUi = ui, sceneSocket = socket, sceneHost = host, sceneFixture = fixture;
  const sceneReads = reads;
  renderer = undefined;
  ui = undefined;
  socket = undefined;
  host = undefined;
  fixture = undefined;
  reads = createReadState();
  sceneReads.releaseRead?.();
  if (sceneRenderer) flushSync(() => sceneRenderer.unmount());
  sceneUi?.dispose();
  sceneSocket?.close();
  sceneHost?.remove();
  if (sceneFixture) await commands.hygieneServer({ op: "stop", id: sceneFixture.id });
  frames.length = 0;
}
afterEach(async () => {
  await disposeScene();
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});
const settle = async () => {
  await new Promise((r) => setTimeout(r, 160));
};
const set = (patch: Record<string, unknown>) => commands.hygieneServer({ op: "set", id: fixture!.id, patch });
async function scene(patch: Record<string, unknown> = {}, width = 320, theme = "dark", height = 1000) {
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
  const sceneFixture = fixture = (await commands.hygieneServer({ op: "start" })) as NonNullable<typeof fixture>;
  await commands.hygieneServer({ op: "set", id: sceneFixture.id, patch: { start: true, ...patch } });
  const sceneReads = reads = createReadState();
  const sceneUi = ui = createBrainUiRoot({
    storage: null,
    request: async (url, init) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith("/hygiene/review") && (!init?.method || init.method === "GET")) {
        sceneReads.reviewReads++;
        if (sceneReads.failedReads > 0) { sceneReads.failedReads--; throw new Error("fixture read unavailable"); }
        if (sceneReads.holdRead) await new Promise<void>((resolve) => { sceneReads.releaseRead = resolve; });
      }
      if (path.includes("/hygiene/review/details/") && sceneReads.detailsOffline) throw new TypeError("Failed to fetch");
      if (path.includes("/hygiene/")) return fetch(url, init);
      if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
      if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
      return new Response("{}", { status: 404 });
    },
  });
  const sceneSocket = socket = new WebSocket(sceneFixture.url.replace("http:", "ws:") + "/ws");
  sceneUi.connection.send = (msg) => {
    if (sceneSocket.readyState !== WebSocket.OPEN) return false;
    frames.push(msg);
    sceneSocket.send(JSON.stringify(msg));
    return true;
  };
  sceneSocket.onmessage = (e) => {
    const p = parseServerMessage(e.data);
    if (!p.ok) throw new Error(p.error);
    sceneUi.connection.handleServerMessage(p.message);
  };
  // Late callbacks keep their original owner, even after it is disposed.
  sceneSocket.onclose = () => sceneUi.stores.inbox.getState().connectionLost();
  await expect.poll(() => sceneUi.stores.inbox.getState().online).toBe(true);
  const sceneHost = host = document.createElement("div");
  sceneHost.style.height = "1000px";
  sceneHost.style.display = "flex";
  sceneHost.className = "bg-background text-foreground";
  document.body.append(sceneHost);
  const sceneRenderer = renderer = createRoot(sceneHost);
  flushSync(() =>
    sceneRenderer.render(
      <BrainUiProvider root={sceneUi}>
        <ActivityPage />
        <DesktopPalette />
      </BrainUiProvider>
    )
  );
  await settle();
  if (
    width >= 1280 &&
    sceneUi.stores.inbox.getState().items &&
    Object.values(sceneUi.stores.inbox.getState().items).some((i) => i.queue === "actions" && i.status === "pending")
  )
    await page.getByRole("button", { name: /^Open finding:/ }).click();
  return sceneHost;
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

test("a disposed scene's held real close cannot take the next scene offline", async () => {
  await scene();
  const previousSocket = socket!;
  const close = previousSocket.onclose!;
  let heldClose: CloseEvent | undefined;
  previousSocket.onclose = event => { heldClose = event; };
  await disposeScene();
  await expect.poll(() => heldClose, { message: "the previous socket's real close is held" }).toBeDefined();
  expect(heldClose!.target, "the held event belongs to the previous real socket").toBe(previousSocket);
  expect(previousSocket.readyState).toBe(WebSocket.CLOSED);

  await scene();
  const nextUi = ui!;
  const nextSocket = socket!;
  await new Promise<void>(resolve => queueMicrotask(() => {
    close.call(previousSocket, heldClose!);
    resolve();
  }));
  expect(nextSocket.readyState, "the next scene's real socket is still open").toBe(WebSocket.OPEN);
  await expect.poll(() => nextUi.stores.inbox.getState().online, {
    message: "the next scene stays online after the previous scene's real close",
  }).toBe(true);
});

test("a disposed scene's held real snapshot cannot populate the next scene's inbox", async () => {
  await scene();
  const previousSocket = socket!;
  const receive = previousSocket.onmessage!;
  const previousId = current().dataset.hygieneId!;
  let heldSnapshot: MessageEvent | undefined;
  previousSocket.onmessage = event => {
    const parsed = parseServerMessage(event.data);
    if (parsed.ok && parsed.message.type === "inbox_snapshot" &&
        parsed.message.items.some(item => item.id === previousId)) heldSnapshot = event;
    else receive.call(previousSocket, event);
  };
  ui!.connection.send({ type: "inbox_subscribe", view: "actions" });
  await expect.poll(() => heldSnapshot, { message: "the previous socket's real inbox snapshot is held" }).toBeDefined();
  expect(heldSnapshot!.target).toBe(previousSocket);
  await disposeScene();

  await scene({ start: false });
  const nextUi = ui!;
  expect(nextUi.stores.inbox.getState().items[previousId], "the next scene starts without the previous finding").toBeUndefined();
  await Promise.resolve().then(() => receive.call(previousSocket, heldSnapshot!));
  expect(nextUi.stores.inbox.getState().items[previousId], "the previous scene's real snapshot stays out of the next inbox").toBeUndefined();
});

test("a disposed scene's sender cannot use the next scene's real socket", async () => {
  await scene();
  const send = ui!.connection.send;
  await disposeScene();
  await scene();
  expect(socket!.readyState).toBe(WebSocket.OPEN);
  const sent = frames.length;
  expect(send({ type: "inbox_subscribe", view: "actions" }), "the disposed scene's sender refuses its closed socket").toBe(false);
  expect(frames.length, "no frame is sent through the next scene's socket").toBe(sent);
});

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
  const sceneUi = ui!, sceneRenderer = renderer!;
  const id = current().dataset.hygieneId;
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => host!.textContent).toContain("Hygiene review paused");
  expect(current().dataset.hygieneId).toBe(id);
  await page.getByRole("button", { name: "Resume hygiene review", exact: true }).click();
  await expect.poll(() => host!.querySelector("[data-hygiene-strip]")?.textContent).toContain("1 of 2 open");
  expect(current().dataset.hygieneId).toBe(id);
  flushSync(() =>
    sceneRenderer.render(
      <BrainUiProvider root={sceneUi}>
        <div />
      </BrainUiProvider>
    )
  );
  flushSync(() =>
    sceneRenderer.render(
      <BrainUiProvider root={sceneUi}>
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
    test(`${theme} ${width}: a Markdown manual finding opens its file`, async () => {
      await scene({ category: "manual" }, width, theme);
      await page.getByRole("button", { name: "Open file ›", exact: true }).click();
      expect(ui!.stores.file.getState().currentPath).toBe("journeys/return-to-ithaca.md");
    });
    // #2723: a managed-worktree finding's path is the logical
    // `reference-worktree://<id>` (#2431), never a brain file.
    for (const kind of ["unknown", "check-failed"])
      test(`${theme} ${width}: a managed-worktree card (${kind}) offers no file to open`, async () => {
        await scene({ category: kind === "unknown" ? "managed-worktree" : "managed-worktree-retained" }, width, theme);
        if (kind === "check-failed") {
          await set({ mode: "check_failed" });
          await apply();
          await expect.poll(() => current().querySelector("[data-hygiene-state]")?.getAttribute("data-hygiene-state")).toBe(
            "check_failed"
          );
        } else expect(current().textContent).toContain("Check again later.");
        expect(current().textContent, "the logical identity stays visible").toContain(
          "reference-worktree://7c1e4a52-3d9b-4f0e-9a61-2b8d5e0c9f13"
        );
        await commands.hygieneServer({
          op: "capture",
          selector: ".bg-background.text-foreground",
          name: `c5-${theme}-${width}-worktree-${kind}.png`,
        });
        const opens = [...current().querySelectorAll("button")].filter((b) => (b.textContent ?? "").startsWith("Open"));
        for (const b of opens) b.click();
        expect(ui!.stores.file.getState().currentPath, "no nonexistent brain file is opened").toBeNull();
        expect(opens.map((b) => b.textContent)).toEqual([]);
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
    const sceneRenderer = renderer!;
    await settle();
    const idleReads = reads.reviewReads;
    await new Promise(r => setTimeout(r, 600));
    expect(reads.reviewReads, "waiting for a pending decision never polls").toBe(idleReads);
    await set({ holdNext: true });
    await page.getByRole("button", { name: "Later ▾", exact: true }).click();
    await page.getByRole("button", { name: "Snooze until the next scheduled time", exact: true }).click();
    await expect.poll(async () => (await set({}) as { selecting: boolean }).selecting).toBe(true);
    await settle();
    reads.holdRead = true;
    await expect.poll(() => !!reads.releaseRead, { message: "selection refresh started another real read" }).toBe(true);
    if (stop === "pause") await page.getByRole("button", { name: "Pause", exact: true }).click();
    else if (stop === "unmount") flushSync(() => sceneRenderer.render(<div />));
    else ui!.stores.inbox.setState(stop === "offline" ? { online: false } : { supported: false });
    await settle();
    reads.holdRead = false;
    reads.releaseRead!(); reads.releaseRead = undefined;
    await settle();
    const stoppedReads = reads.reviewReads;
    await new Promise(r => setTimeout(r, 700));
    expect(reads.reviewReads, `${stop} cancels selection refresh even after its read returns`).toBe(stoppedReads);
  });

test("transient selection refresh retries an unavailable REST read and stops at server completion", async () => {
  await scene({ remaining: 1 });
  await set({ holdNext: true });
  await page.getByRole("button", { name: "Later ▾", exact: true }).click();
  await page.getByRole("button", { name: "Snooze until the next scheduled time", exact: true }).click();
  await expect.poll(async () => (await set({}) as { selecting: boolean }).selecting).toBe(true);
  reads.failedReads = 1;
  await expect.poll(() => reads.failedReads).toBe(0);
  await set({ releaseNext: true });
  await expect.poll(() => host!.textContent, { message: "server completion arrives after a failed read" }).toContain("Review complete");
  await expect.poll(() => document.activeElement?.textContent).toBe("Review complete");
  await settle();
  const finalReads = reads.reviewReads;
  await new Promise(r => setTimeout(r, 700));
  expect(reads.reviewReads, "completed review stops selection refresh").toBe(finalReads);
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
  const readsAtDisconnect = reads.reviewReads;
  await new Promise(r => setTimeout(r, 600));
  expect(reads.reviewReads, "disconnect clears the scheduled selection read").toBe(readsAtDisconnect);
});

for (const width of [320, 1280])
  test(`${width}: REST-only refreshed finding waits for replicated authority and never replays a click`, async () => {
    await scene({}, width);
    await chooseText();
    await set({ mode: "stale" });
    await apply();
    await expect.poll(() => current().textContent).toContain("This file changed");
    const oldId = current().dataset.hygieneId!;
    const sceneSocket = socket!;
    const receive = sceneSocket.onmessage!;
    const held: MessageEvent[] = [];
    sceneSocket.onmessage = event => { held.push(event); };
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
      sceneSocket.onmessage = receive;
      for (const event of held.splice(0)) receive.call(sceneSocket, event);
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
      sceneSocket.onmessage = receive;
      for (const event of held) receive.call(sceneSocket, event);
    }
  });

for (const width of [320, 1280])
  for (const operation of ["start", "resume"] as const)
    test(`${width}: REST-only ${operation} keeps manual and disposition controls unavailable until replication`, async () => {
      await scene({ start: false, category: "manual" }, width);
      await page.getByRole("tab", { name: /^needs you / }).click();
      const sceneSocket = socket!;
      const receive = sceneSocket.onmessage!;
      const held: MessageEvent[] = [];
      sceneSocket.onmessage = event => { held.push(event); };
      try {
        await page.getByRole("button", { name: "Start hygiene review", exact: true }).click();
        await expect.poll(() => current()?.dataset.hygieneId).toBeTruthy();
        const id = current().dataset.hygieneId!;
        if (operation === "resume") {
          await page.getByRole("button", { name: "Pause", exact: true }).click();
          await expect.poll(() => host!.textContent).toContain("Hygiene review paused");
          await page.getByRole("button", { name: "Resume hygiene review", exact: true }).click();
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
        sceneSocket.onmessage = receive;
        for (const event of held.splice(0)) receive.call(sceneSocket, event);
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
        sceneSocket.onmessage = receive;
        for (const event of held) receive.call(sceneSocket, event);
      }
    });

for (const recovery of ["unknown", "undo"] as const)
  test(`REST-only ${recovery} recovery waits for replicated authority`, async () => {
    await scene({ start: false });
    await page.getByRole("tab", { name: /^needs you / }).click();
    const sceneSocket = socket!;
    const receive = sceneSocket.onmessage!;
    const held: MessageEvent[] = [];
    sceneSocket.onmessage = event => { held.push(event); };
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
      await page.getByRole("button", { name: "Resume hygiene review", exact: true }).click();
      const label = recovery === "unknown" ? "Check again" : "Undo change";
      const button = page.getByRole("button", { name: label, exact: true });
      await expect.element(button).toBeVisible();
      expect((button.element() as HTMLButtonElement).disabled, `${label} waits for replicated authority`).toBe(true);
      (button.element() as HTMLButtonElement).click();
      expect(host!.querySelector("[data-hygiene-id]")?.textContent).not.toContain("Undo change · inverse preview");
      expect(frames.filter(f => f.type === "inbox_resolve" && f.itemId === id)).toHaveLength(0);
      await expect.poll(() => held.length).toBeGreaterThan(0);
      sceneSocket.onmessage = receive;
      for (const event of held.splice(0)) receive.call(sceneSocket, event);
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
      sceneSocket.onmessage = receive;
      for (const event of held) receive.call(sceneSocket, event);
    }
  });

// #2734: owner-only private details of a private managed-worktree card. The
// fixture's host read returns the approved Odysseus facts: 14 changed paths,
// 5 sampled, recorded 2026-07-12.
const PRIVATE_BYTES = ["github.com/ithaca/palace-ledger", "refs/heads/raft-repairs", "3f9a2c1d4e5b7a8c9d0e1f2a3b4c5d6e7f8a9b0c", "olive-oil", "wine-stores", "antinous", "Telemachus research"];
const toggle = () => page.getByRole("button", { name: "Private details", exact: true });
/** Capture the visible full card whole: a viewport tall enough for it, then the scene's own. */
async function captureCard(name: string) {
  const [width, height] = [innerWidth, innerHeight];
  const before = host!.style.height;
  host!.style.height = "1800px";
  await page.viewport(width, 1800);
  await settle();
  const selector = host!.querySelector("[data-hygiene-detail] [data-hygiene-id]") ? "[data-hygiene-detail] [data-hygiene-id]" : "[data-hygiene-id]";
  await commands.hygieneServer({ op: "capture", selector, name });
  host!.style.height = before;
  await page.viewport(width, height);
  await settle();
}
const region = () => current().querySelector<HTMLElement>('[role="region"][aria-label="Private details"]');
const rows = () => region()?.querySelector("[data-hygiene-private-rows]") ?? null;
const detailReads = async () => ((await set({})) as { detailReads: string[] }).detailReads;
function noPrivateBytes(where: string) {
  const text = host!.textContent ?? "";
  for (const secret of PRIVATE_BYTES) expect(text.includes(secret), `${where}: ${secret}`).toBe(false);
}
const noHorizontalScroll = () =>
  expect(
    { page: document.documentElement.scrollWidth <= innerWidth, card: current().scrollWidth <= current().clientWidth },
    "no horizontal scroll"
  ).toEqual({ page: true, card: true });
async function expandDetails() {
  await toggle().click();
  await expect.poll(() => rows(), { message: "the owner's rows load" }).not.toBeNull();
}
for (const theme of ["dark", "light"])
  for (const [width, height] of [[320, 640], [1440, 900], [720, 450]] as const)
    test(`${theme} ${width}×${height}: the owner opens, reads and collapses private details${width === 720 ? " (1440 at 200% zoom)" : ""}`, async () => {
      await scene({ category: "managed-worktree-retained" }, width, theme, height);
      const button = toggle().element() as HTMLButtonElement;
      expect({ tag: button.tagName, expanded: button.getAttribute("aria-expanded"), controls: document.getElementById(button.getAttribute("aria-controls") ?? "") === region() },
        "a native toggle that controls the region").toEqual({ tag: "BUTTON", expanded: "false", controls: true });
      expect(button.getBoundingClientRect().height, "44px target").toBeGreaterThanOrEqual(44);
      expect(current().textContent).toContain("Owner only · not sent to other devices or agents");
      expect(region()?.hidden, "collapsed by default").toBe(true);
      expect(await detailReads(), "nothing is fetched until opened").toEqual([]);
      noPrivateBytes("collapsed card");
      // Tab order: title, then the toggle.
      title().focus();
      await userEvent.tab();
      expect(document.activeElement, "the toggle follows the title").toBe(button);
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => rows()).not.toBeNull();
      expect(document.activeElement, "focus stays on the toggle").toBe(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(await detailReads()).toHaveLength(1);
      await expect.poll(() => current().querySelector('[role="status"].bk-sr-only')?.textContent).toBe("Private details shown");
      const text = region()!.textContent!;
      for (const expected of ["OWNED BY", "Telemachus research (agent)", "REPOSITORY", "github.com/ithaca/palace-ledger", "REVISION", "refs/heads/raft-repairs",
        "STARTING COMMIT", "3f9a2c1d4e5b7a8c9d0e1f2a3b4c5d6e7f8a9b0c", "CHANGED PATHS", "14 in total · first 5 shown", "2 paths couldn't be compared."])
        expect(text, "approved row").toContain(expected);
      expect(text).toMatch(/As recorded \w{3} 12 Jul, \d\d:02\./);
      expect([...region()!.querySelectorAll("li")].map((li) => li.textContent)).toHaveLength(5);
      // Stacked below 480px, two columns above it.
      const [dt, dd] = [region()!.querySelector("dt")!.getBoundingClientRect(), region()!.querySelector("dd")!.getBoundingClientRect()];
      const wide = region()!.getBoundingClientRect().width >= 480;
      expect(wide ? dd.left > dt.right - 1 && Math.abs(dd.top - dt.top) < 4 : dd.top >= dt.bottom - 1, `${wide ? "two columns" : "stacked"} at ${width}`).toBe(true);
      noHorizontalScroll();
      // The commit wraps rather than truncating.
      const commit = [...region()!.querySelectorAll("dd")].find((el) => el.textContent?.startsWith("3f9a2c"))!;
      expect(commit.scrollWidth <= commit.clientWidth, "starting commit wraps").toBe(true);
      // The next stop is outside the non-interactive region: the review controls.
      await userEvent.tab();
      expect(region()!.contains(document.activeElement), "rows hold no tab stop").toBe(false);
      await captureCard(`c2734-${theme}-${width}-private-details.png`);
      // Escape is not a binding of this inline disclosure.
      button.focus();
      await userEvent.keyboard("{Escape}");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      await userEvent.keyboard(" ");
      expect(button.getAttribute("aria-expanded"), "Space toggles once").toBe("false");
      expect(document.activeElement, "collapse keeps focus on the toggle").toBe(button);
      expect(rows(), "collapse drops the rows").toBeNull();
      noPrivateBytes("collapsed again");
      expect(await detailReads(), "one read per opening").toHaveLength(1);
    });
for (const theme of ["dark", "light"])
  for (const width of [320, 1440])
    test(`${theme} ${width}: a delegated agent sees today's card, with no toggle and no private bytes`, async () => {
      await scene({ category: "managed-worktree-retained", as: "agent" }, width, theme, width === 320 ? 640 : 900);
      await expect.poll(() => current()?.textContent).toContain("private source · 14 changed paths · released");
      expect(current().querySelector("[data-hygiene-private-details]"), "no toggle").toBeNull();
      expect(current().textContent).not.toContain("Private details");
      expect(current().textContent, "no hint either").not.toContain("Owner only");
      noPrivateBytes("agent card");
      const ax = (await commands.hygieneServer({ op: "ax", selector: "body" })) as { nodes: Array<{ name?: { value: string } }> };
      const names = ax.nodes.map((node) => node.name?.value ?? "").join("\n");
      for (const secret of [...PRIVATE_BYTES, "Private details"]) expect(names.includes(secret), `accessibility tree: ${secret}`).toBe(false);
      const direct = await fetch(`${fixture!.url}/api/hygiene/review/details/${encodeURIComponent(current().dataset.hygieneId!)}`);
      expect({ status: direct.status, body: await direct.text() }, "a direct request is refused").toEqual({ status: 403, body: JSON.stringify({ error: "Unauthorized" }) });
      expect(await detailReads(), "the host never reads facts for an agent").toEqual([]);
      await captureCard(`c2734-${theme}-${width}-agent-card.png`);
    });
test("unknown reads differently from zero, and hostile-looking path text stays inert", async () => {
  await scene({ category: "managed-worktree-retained", details: "zero" });
  await expandDetails();
  expect(region()!.textContent).toContain("CHANGED PATHS");
  expect(region()!.querySelector("dt:nth-of-type(5) + dd")?.textContent, "a known zero").toBe("None");
  await toggle().click();
  await set({ details: "unknown" });
  await expandDetails();
  const text = region()!.textContent!;
  expect(region()!.querySelector("dt:nth-of-type(5) + dd")?.textContent, "unknown is never zero").toBe("Not established yet");
  for (const expected of ["Removed principal", "Assessment time unknown."]) expect(text).toContain(expected);
  expect(text.match(/Not recorded/g), "repository, revision and commit").toHaveLength(3);
  await toggle().click();
  await set({ details: "hostile" });
  await expandDetails();
  const first = region()!.querySelector("li")!;
  expect(first.textContent, "rendered literally").toBe("[x](http://e.test)<b>y</b>");
  expect(region()!.querySelectorAll("a, b").length, "never linkified or interpreted").toBe(0);
  noHorizontalScroll();
});
test("a late reply for a collapsed or replaced card is discarded", async () => {
  await scene({ category: "managed-worktree-retained", details: "hold" });
  await toggle().click();
  await expect.poll(() => region()?.getAttribute("aria-busy")).toBe("true");
  expect(region()!.querySelector('[role="group"][aria-label="Loading private details"]'), "named loading placeholder").not.toBeNull();
  expect(document.activeElement, "focus stays on the toggle while loading").toBe(toggle().element());
  await toggle().click();
  await set({ releaseDetails: true });
  await settle();
  expect({ rows: rows(), expanded: toggle().element().getAttribute("aria-expanded") }, "the late reply is dropped").toEqual({ rows: null, expanded: "false" });
  noPrivateBytes("after a late reply");
  // A reply that lands after the card's version moved on is dropped too.
  await toggle().click();
  await set({ longFinding: true });
  await expect.poll(() => current().querySelector("[data-hygiene-private-details] [aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
  await set({ releaseDetails: true, details: "details" });
  await settle();
  expect(rows(), "no previous card's bytes").toBeNull();
  noPrivateBytes("after a version change");
});
test("a disconnect clears the details", async () => {
  await scene({ category: "managed-worktree-retained" });
  await expandDetails();
  socket!.close();
  await expect.poll(() => ui!.stores.inbox.getState().online).toBe(false);
  await expect.poll(() => rows(), { message: "disconnect clears the rows" }).toBeNull();
  expect(toggle().element().getAttribute("aria-expanded")).toBe("false");
  noPrivateBytes("after disconnect");
});
test("an Actions-limit set-aside clears the details with the card", async () => {
  await scene({ category: "managed-worktree-retained" });
  await expandDetails();
  await set({ fillActions: true });
  await expect.poll(() => host!.querySelector("[data-hygiene-limit]")).not.toBeNull();
  await expect.poll(() => host!.querySelector("[data-hygiene-private-details]")).toBeNull();
  noPrivateBytes("after set-aside");
});
for (const theme of ["dark", "light"])
  test(`${theme}: changed, gone, offline, failed and refused replies show no detail rows`, async () => {
    await scene({ category: "managed-worktree-retained", details: "changed" }, 320, theme, 640);
    await toggle().click();
    await expect.poll(() => region()?.textContent).toContain("This worktree changed since the card was shown. Refresh the finding to see current details.");
    expect(rows()).toBeNull();
    const refresh = [...region()!.querySelectorAll("button")].find((b) => b.textContent === "Refresh finding")!;
    expect(refresh, "the existing refresh action").toBeTruthy();
    await captureCard(`c2734-${theme}-320-changed.png`);
    // Invalidation while focus is inside moves it to the card title.
    refresh.focus();
    expect(document.activeElement, "Refresh holds focus").toBe(refresh);
    socket!.close();
    await expect.poll(() => document.activeElement).toBe(title());
    expect(region()?.hidden).toBe(true);
  });
for (const [state, text, retry] of [
  ["gone", "This finding is no longer open. There's nothing to show.", false],
  ["fail", "Couldn't load the details. Nothing was changed.", true],
  ["offline", "Can't reach your brain right now.", true],
] as const)
  test(`a ${state} reply shows its message and no rows`, async () => {
    await scene({ category: "managed-worktree-retained", details: state === "offline" ? "details" : state });
    reads.detailsOffline = state === "offline";
    await toggle().click();
    await expect.poll(() => region()?.textContent).toContain(text);
    expect(rows()).toBeNull();
    await expect.poll(() => current().querySelector('[role="status"].bk-sr-only')?.textContent).toBe(text);
    const again = [...region()!.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    expect(!!again, "Try again").toBe(retry);
    if (again) {
      reads.detailsOffline = false;
      await set({ details: "details" });
      again.click();
      await expect.poll(() => rows(), { message: "Try again reads again" }).not.toBeNull();
    }
  });
test("a refusal collapses, removes the toggle on the next review read and returns focus to the title", async () => {
  await scene({ category: "managed-worktree-retained" });
  await set({ as: "agent" });
  await toggle().click();
  await expect.poll(() => document.activeElement).toBe(title());
  await expect.poll(() => current().querySelector("[data-hygiene-private-details]"), { message: "toggle removed" }).toBeNull();
  noPrivateBytes("after refusal");
});
// #2837: a managed worktree is host state, not a file. Its card names the
// removal or the check, claims only what the outcome shows, and keeps inert
// host reasons. Markdown findings keep their file wording above.
const FILE_WORDING = ["file", "written", "validation", "Couldn't write", "Done, check again"];
function noFileWording(where: string) {
  const text = current().textContent ?? "";
  for (const word of FILE_WORDING) expect(text.includes(word), `${where}: no "${word}"`).toBe(false);
  // The logical identity appears once, as the card's identifier, never in a sentence.
  expect(text.split("reference-worktree://").length - 1, `${where}: identity only in its PathRef`).toBe(1);
}
/** The state callout's own sentence, without its recovery controls. */
const stateText = () => current().querySelector("[data-hygiene-state]")?.firstElementChild?.textContent ?? "";
const REMOVAL_CHECK = "Before removing it, the host checks the worktree again and refuses if it changed since this preview.";
const CHECK_EXPLANATION = "Checks its current state. A worktree verified clean and unused may be reclaimed automatically.";
for (const theme of ["dark", "light"])
  for (const width of [320, 1280]) {
    test(`${theme} ${width}: a worktree removal's states name the removal and keep their reasons inert`, async () => {
      const long = "The worktree could not be removed; it is kept for review. [x](http://e.test)<b>y</b> " + "ithaca-harbour-".repeat(8);
      await scene({ category: "managed-worktree-retained", hostReason: long }, width, theme);
      expect(current().textContent, "removal post-check").toContain(REMOVAL_CHECK);
      noFileWording("fresh removal card");
      const id = current().dataset.hygieneId!;
      for (const [mode, expected] of [
        ["stale", "This worktree changed since the finding was shown. Refresh the finding to review it again."],
        ["refused", `The host refused the removal: ${long}`],
        ["check_failed", `The removal didn't finish: ${long}`],
        ["check_failed_other", "The removal couldn't be confirmed: The finding is still detected after removal."],
      ] as const) {
        await set({ mode });
        await apply();
        const focused = document.activeElement;
        await expect.poll(() => stateText(), { message: `${mode} copy`, timeout: 5000 }).toBe(expected);
        await expect.poll(() => ui!.stores.inbox.getState().inFlight[id]).toBeUndefined();
        expect(current().dataset.hygieneId, `same card after ${mode}`).toBe(id);
        expect(document.activeElement, `focus stays put after ${mode}`).toBe(focused);
        noFileWording(mode);
        if (mode === "check_failed") {
          expect(current().querySelector("[data-hygiene-state] b"), "a reason is never interpreted").toBeNull();
          expect(current().scrollWidth <= current().clientWidth, "a long reason wraps").toBe(true);
          await commands.hygieneServer({ op: "capture", selector: ".bg-background.text-foreground", name: `c2837-${theme}-${width}-cleanup-failed.png` });
        }
      }
      // Applying, then an unconfirmed reply.
      await set({ mode: "hold" });
      await apply();
      await expect.poll(() => stateText(), { timeout: 5000 }).toBe("Removing… checking the worktree first");
      expect(current().querySelector("[data-disposition-bar]")?.textContent, "busy label").toContain("Removing… checking the worktree first");
      noFileWording("applying");
      await set({ mode: "unknown", release: true });
      await expect.poll(() => stateText(), { timeout: 5000 }).toContain("The outcome wasn't confirmed. Check again.");
      noFileWording("unknown reply");
    });
    test(`${theme} ${width}: a worktree with no repair offers Check again, which may reclaim it, and a confirmed removal reads as removed`, async () => {
      await scene({ category: "managed-worktree" }, width, theme);
      const check = page.getByRole("button", { name: "Check again", exact: true });
      await expect.element(check).toBeVisible();
      expect(current().textContent, "approved check explanation").toContain(CHECK_EXPLANATION);
      expect(current().textContent, "never a no-removal promise").not.toContain("never removes");
      noFileWording("no-repair card");
      await commands.hygieneServer({ op: "capture", selector: ".bg-background.text-foreground", name: `c2837-${theme}-${width}-check-again.png` });
      // Keyboard: the commit control is reachable and answers once.
      (check.element() as HTMLButtonElement).focus();
      await set({ mode: "hold" });
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => stateText(), { timeout: 5000 }).toBe("Checking the worktree again…");
      await set({ mode: "", release: true });
      await expect.poll(() => stateText(), { timeout: 5000 }).toBe("Still needs review.");
      noFileWording("still detected");
      expect(frames.filter((f) => f.type === "inbox_resolve" && f.optionId === "check"), "one check sent").toHaveLength(1);
      // A check that clears the finding claims no removal.
      const id = current().dataset.hygieneId!;
      await set({ mode: "check_clear" });
      await check.click();
      await expect.poll(() => ui!.stores.inbox.getState().items[id]?.status).toBe("resolved");
      await page.getByRole("tab", { name: /^done / }).click();
      await expect.poll(() => host!.querySelector("[data-hygiene-fixed]")?.textContent).toBe("No longer needs review");
    });
  }
test("a confirmed removal from this device reads Worktree removed; the Done list claims only that the finding cleared", async () => {
  await scene({ category: "managed-worktree-retained" });
  const id = current().dataset.hygieneId!;
  const seen: string[] = [];
  const sceneHost = host!;
  const observer = new MutationObserver(() => { const t = sceneHost.querySelector('[data-hygiene-card][role="status"]')?.textContent; if (t) seen.push(t); });
  observer.observe(sceneHost, { subtree: true, childList: true, characterData: true });
  try {
    await apply();
    await expect.poll(() => ui!.stores.inbox.getState().items[id]?.status).toBe("resolved");
  } finally { observer.disconnect(); }
  // The transient fixed callout, whenever it paints, names only the confirmed removal.
  expect([...new Set(seen)], "the fixed callout, while it paints, names the confirmed removal").toEqual(["Worktree removed"]);
  await page.getByRole("tab", { name: /^done / }).click();
  await expect.poll(() => host!.querySelector("[data-hygiene-fixed]")?.textContent).toBe("No longer needs review");
  expect(host!.textContent).not.toContain("Finding no longer detected in reference-worktree://");
});
