/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button } from "@schlessera/brain-ui-kit";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { LocalWorkDialog } from "../../src/components/voice/local-work-dialog.js";
import { DiagnosticReview } from "../../src/components/report/diagnostic-review.js";
import { CompareDrafts, DraftSaveLine } from "../../src/components/chat/draft-save-line.js";
import { updateHeld } from "../../src/lib/update-holds.js";

let styles: HTMLStyleElement;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
const frame = async () => { await new Promise<void>(r => requestAnimationFrame(() => r())); await new Promise<void>(r => requestAnimationFrame(() => r())); };
type Site = "local" | "diagnostic" | "compare";
const names = { local: "Drafts recorded before you signed in", diagnostic: "What will be copied", compare: "Compare drafts" };

async function mount(ctx: TestContext, site: Site, width = 1280, theme = "dark", focusAction = false, refuse = false) {
  const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  document.documentElement.dataset.theme = theme;
  const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  const id = ui.stores.drafts.getState().fresh;
  if (site === "compare") {
    ui.stores.drafts.getState().edit(id, null, { text: "Ask Penelope about the loom" });
    ui.stores.drafts.getState().conflictWith(id, { draftId: id, sessionId: null, text: "Ask Eumaeus about the flock", attachments: [], revision: 2, updatedAt: Date.UTC(2026, 6, 12, 9, 42) }, true);
  }
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host);
  let closes = 0;
  let hideOpener = () => {};
  function Scene() {
    const [open, setOpen] = useState(false);
    const [showOpener, setShowOpener] = useState(true);
    useEffect(() => { hideOpener = () => flushSync(() => setShowOpener(false)); }, []);
    const close = () => { closes++; if (!refuse) setOpen(false); };
    return <BrainUiProvider root={ui}>
      {showOpener && <Button label="Review Ithaca work" onClick={() => setOpen(true)} />}
      <h2 data-fallback tabIndex={-1}>Ithaca actions</h2>
      {open && (site === "local" ? <LocalWorkDialog title={names.local} onCancel={close} focusAction={focusAction}>
        <p>These recordings stay on this device.</p>
        <Button label="Add selected to my account" disabled />
        <span data-initial-focus><Button label="Keep working" onClick={close} /></span>
        <Button label="Sign out and delete" tone="danger" onClick={close} />
      </LocalWorkDialog> : site === "diagnostic" ? <DiagnosticReview mode="copy" initialBody="Ithaca route failed" defaultIssueTitle="Ithaca route"
        onClose={close} returnFocus={() => host.querySelector<HTMLElement>("[data-fallback]")?.focus()} /> : <CompareDrafts draftId={id} onClose={close} />)}
    </BrainUiProvider>;
  }
  ctx.onTestFinished(async () => {
    flushSync(() => renderer.unmount()); await frame(); ui.dispose(); host.remove();
    document.documentElement.dataset.theme = before.theme;
    await page.viewport(before.width, before.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  flushSync(() => renderer.render(<StrictMode><Scene /></StrictMode>));
  const opener = host.querySelector<HTMLElement>("[role=button],button")!;
  opener.focus(); await userEvent.click(opener); await frame();
  const dialog = () => document.querySelector<HTMLDialogElement>(site === "local" ? "[data-local-work-dialog]" : site === "diagnostic" ? "[data-diagnostic-review]" : "[data-compare-drafts]");
  expect(dialog(), "review dialog mounted").not.toBeNull();
  return { ui, id, host, opener, dialog, hideOpener, closes: () => closes };
}

for (const site of ["local", "diagnostic", "compare"] as const) for (const theme of ["dark", "light"]) for (const width of [320, 1280]) {
  const cell = `${site} ${theme} ${width}`;
  test(`${cell}: initial focus and accessible name`, async ctx => {
    // Mutation: remove the adapter's initialFocus; heading entry assertion fails.
    const s = await mount(ctx, site, width, theme);
    expect(document.activeElement, "review focuses its reading heading").toBe(s.dialog()!.querySelector("h2"));
    const d = s.dialog()!;
    expect(d.getAttribute("aria-label") ?? document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent, "preserved review name").toBe(names[site]);
    expect(d.matches("dialog:modal"), "review uses native modal top layer").toBe(true);
  });
  test(`${cell}: traps Tab in both directions`, async ctx => {
    // Mutation: replace showModal with show and disable Overlay's Tab wrap.
    const s = await mount(ctx, site, width, theme);
    const d = s.dialog()!;
    const stops = [...d.querySelectorAll<HTMLElement>('button,[role=button],input,textarea,[tabindex]')].filter(el => el.tabIndex >= 0 && !el.matches(":disabled,[aria-disabled=true]") && el.getClientRects().length > 0);
    expect(stops.length, "nonempty review controls").toBeGreaterThan(1);
    stops.at(-1)!.focus(); await userEvent.keyboard("{Tab}");
    expect(document.activeElement, "Tab wraps to first review control").toBe(stops[0]);
    stops[0]!.focus(); await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement, "Shift-Tab wraps to last review control").toBe(stops.at(-1));
    for (let i = 0; i < stops.length + 2; i++) { await userEvent.keyboard("{Tab}"); expect(d.contains(document.activeElement), "Tab remains inside review").toBe(true); }
  });
  test(`${cell}: Escape requests dismissal`, async ctx => {
    // Mutation: replace each adapter's onClose with a no-op.
    const s = await mount(ctx, site, width, theme);
    await userEvent.keyboard("{Escape}"); await frame();
    expect(s.dialog(), "Escape dismisses review").toBeNull();
    expect(s.closes(), "one close request").toBe(1);
  });
  test(`${cell}: closing returns opener focus`, async ctx => {
    // Mutation: disable Overlay's returnFocus policy.
    const s = await mount(ctx, site, width, theme);
    await userEvent.keyboard("{Escape}"); await frame();
    expect(document.activeElement, "review returns focus to its opener").toBe(s.opener);
  });
  test(`${cell}: scrim follows caller policy`, async ctx => {
    // Mutation: change local closerequest to any, and the other adapters to closerequest.
    const s = await mount(ctx, site, width, theme);
    await userEvent.click(s.dialog()!.querySelector(".bk-overlay-scrim")!, { position: { x: 8, y: 8 } }); await frame();
    expect(s.closes(), "preserved scrim close policy").toBe(site === "local" ? 0 : 1);
    expect(!!s.dialog(), "scrim leaves local work mounted only").toBe(site === "local");
  });
}

for (const site of ["local", "diagnostic", "compare"] as const) for (const theme of ["dark", "light"]) for (const width of [320, 899, 900, 1280]) {
  test(`${site} ${theme} ${width}: shared 900px geometry`, async ctx => {
    // Mutation: force top placement instead of responsive center.
    const s = await mount(ctx, site, width, theme);
    const surface = s.dialog()!.querySelector<HTMLElement>(".bk-overlay-surface")!;
    const r = surface.getBoundingClientRect();
    expect(Math.abs(width < 900 ? r.bottom - innerHeight : r.top + r.height / 2 - innerHeight / 2), "review docks below 900 and centers from 900").toBeLessThanOrEqual(1);
    expect(r.left, "surface within viewport left").toBeGreaterThanOrEqual(0);
    expect(r.right, "surface within viewport right").toBeLessThanOrEqual(width);
    expect(document.documentElement.scrollWidth, "review causes no page overflow").toBe(width);
  });
}

test("local work: action focus, caller refusal and update hold survive StrictMode", async ctx => {
  // Mutations: remove surfaceRef action selection; drop registerUpdateHold.
  const s = await mount(ctx, "local", 320, "light", true, true);
  expect(document.activeElement?.textContent, "safe action initially focused").toBe("Keep working");
  expect(updateHeld(s.ui), "open local work holds update takeover").toBe(true);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.closes(), "Escape reaches refusing caller once").toBe(1);
  expect(s.dialog()?.matches(":modal"), "caller may refuse close without native dismissal").toBe(true);
});

test("local work: releasing the dialog releases its update hold", async ctx => {
  // Mutation: discard registerUpdateHold's release in the effect cleanup.
  const s = await mount(ctx, "local");
  await userEvent.keyboard("{Escape}"); await frame();
  expect(updateHeld(s.ui), "closed local work releases update takeover").toBe(false);
});

test("diagnostic: missing opener falls back to Actions", async ctx => {
  // Mutation: remove the adapter's fallback returnFocus call.
  const s = await mount(ctx, "diagnostic");
  s.hideOpener();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.activeElement, "missing review opener focuses Actions fallback").toBe(s.host.querySelector("[data-fallback]"));
});

test("local work under diagnostic: only topmost Escape closes and returns into local work", async ctx => {
  // Mutation: restore LocalWorkDialog's window capture Escape listener.
  const s = await mount(ctx, "local");
  const lower = s.dialog()!;
  const opener = lower.querySelector<HTMLElement>('[role=button]:not([aria-disabled=true]),button:not(:disabled)')!;
  opener.focus();
  const host = document.createElement("div"); lower.querySelector(".bk-overlay-body")!.append(host);
  const renderer = createRoot(host);
  ctx.onTestFinished(() => flushSync(() => renderer.unmount()));
  let upper = true;
  function Scene() { const [open, setOpen] = useState(true); return open ? <DiagnosticReview mode="copy" initialBody="Ithaca route failed" defaultIssueTitle="Ithaca route" onClose={() => { upper = false; setOpen(false); }} /> : null; }
  flushSync(() => renderer.render(<Scene />)); await frame();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.closes(), "Escape does not reach underlying local work").toBe(0);
  expect(upper, "Escape closes topmost review").toBe(false);
  expect(lower.matches(":modal"), "local work remains modal underneath").toBe(true);
  expect(document.activeElement, "topmost close returns into underlying review").toBe(opener);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.dialog(), "second Escape closes local work").toBeNull();
});


test("draft comparison: dismissal returns to Compare after activation without focus", async ctx => {
  // Mutation: omit DraftSaveLine's explicit Compare returnFocus policy.
  const s = await mount(ctx, "compare", 320, "light");
  await userEvent.keyboard("{Escape}"); await frame();
  const host = document.createElement("div"); s.host.append(host);
  const renderer = createRoot(host);
  ctx.onTestFinished(() => flushSync(() => renderer.unmount()));
  flushSync(() => renderer.render(<BrainUiProvider root={s.ui}>
    <input aria-label="Other Ithaca field" />
    <DraftSaveLine draftId={s.id} />
  </BrainUiProvider>));
  const trigger = host.querySelector<HTMLButtonElement>("[data-draft-compare]")!;
  const field = host.querySelector("input")!;
  expect(trigger, "actual conflict Compare trigger exists").not.toBeNull();
  field.focus();
  expect(document.activeElement, "activation starts outside Compare").toBe(field);
  // Native click() models activation that does not focus the trigger, as touch
  // can do; all focus and dismissal thereafter run in actual Chromium.
  flushSync(() => trigger.click()); await frame();
  expect(s.dialog()?.matches(":modal"), "actual draft line opens comparison").toBe(true);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.activeElement, "comparison returns to explicit Compare trigger").toBe(trigger);
});
