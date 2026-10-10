/// <reference types="@vitest/browser-playwright" />
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { ComposerRow } from "../../src/chrome/ComposerRow.js";
import { ModelPicker } from "../../src/chrome/ModelPicker.js";
import { Overlay } from "../../src/chrome/Overlay.js";
import { PendingFollowUps } from "../../src/chrome/PendingFollowUps.js";
import { SessionStrip } from "../../src/chrome/SessionStrip.js";
import { TextButton } from "../../src/primitives/TextButton.js";
import { pendingFollowUps } from "../../fixtures/follow-ups.js";
import { WORKING_NOW, workingSessions } from "../../fixtures/sessions.js";
import "../../src/styles.css";

// Real size containers and an opposing subtree theme: showModal must escape
// containment while inheriting tokens, without relocating either sheet.
type Site = "working" | "pending" | "model";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalTheme = document.documentElement.dataset.theme;
const viewport = { width: innerWidth, height: innerHeight };
let outer: { width: number; height: number } | undefined;
afterEach(async () => {
  if (root) flushSync(() => root!.unmount());
  root = undefined; host?.remove(); host = undefined;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
  await commands.dictationMotion("no-preference");
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  outer = undefined;
});
const selector = (site: Site) => site === "model" ? '[data-bk-sheet-adapter="model"]' : `[data-${site}-sheet]`;
const sheet = (site: Site) => host!.querySelector<HTMLDialogElement>(selector(site));
const stops = (site: Site) => [...sheet(site)!.querySelectorAll<HTMLElement>('[role="button"], [data-pending-row], input[tabindex="0"]:not(:disabled)')];
const opener = (site: Site) => host!.querySelector<HTMLElement>(site === "model" ? '[data-model-opener]' : `[data-${site === "working" ? "strip" : "pending"}-summary]`)!;
async function mount(site: Site, width: number, theme: string) {
  outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  await commands.dictationMotion("reduce");
  document.documentElement.dataset.theme = theme === "dark" ? "light" : "dark";
  const actions = { model: vi.fn(), effort: vi.fn(), working: vi.fn() };
  function Harness() {
    const [picker, setPicker] = useState(false);
    const [upper, setUpper] = useState(false);
    const [model, setModel] = useState("raft");
    return <div data-theme={theme} style={{ transform: "translateZ(0)", width: 280, height: 180, containerType: "size" }}>
      <TextButton data-model-opener="" label="Choose model" onClick={() => setPicker(true)} />
      <TextButton data-upper-opener="" label="Open review" onClick={() => setUpper(true)} />
      <TextButton data-session-destination="" label="Opened session" onClick={() => {}} />
      <ComposerRow
        left={site === "working" ? <SessionStrip now={WORKING_NOW} sessions={workingSessions.slice(0, 4).map(s => ({ ...s, onOpen: () => {
          actions.working(s.id); host!.querySelector<HTMLElement>('[data-session-destination]')!.focus();
        } }))} /> : undefined}
        right={site === "pending" ? <PendingFollowUps followUps={pendingFollowUps.slice(0, 4)} /> : undefined}
      />
      {picker && <ModelPicker phone models={[{ id: "raft", label: "Raft model" }, { id: "sail", label: "Sail model" }]}
        selectedModelId={model} defaultEffort="medium" effortLevels={["low", "medium", "high"]}
        onModel={id => { actions.model(id); setModel(id); }}
        onEffort={level => { actions.effort(level); setPicker(false); }} onDismiss={() => setPicker(false)} />}
      <Overlay open={upper} variant="dialog" label="Review raft" onClose={() => setUpper(false)}>
        <TextButton data-upper-stop="" label="Review timber" onClick={() => {}} />
      </Overlay>
    </div>;
  }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root!.render(<Harness />));
  await document.fonts.ready;
  return actions;
}
async function open(site: Site) {
  opener(site).focus(); await userEvent.keyboard('{Enter}');
  await expect.poll(() => sheet(site), { message: "the requested sheet opens" }).not.toBeNull();
}

for (const site of ["working", "pending", "model"] as const) for (const theme of ["dark", "light"]) for (const width of [320, 1280]) {
  const scene = `${site}, ${theme}, ${width}`;
  test(`sheet entry and native inertness: ${scene}`, async () => {
    await mount(site, width, theme); await open(site);
    expect(document.activeElement, "focus enters the first content stop").toBe(stops(site)[0]);
    expect(sheet(site)!.matches(':modal'), "the adapter uses the native modal top layer").toBe(true);
    const active = document.activeElement;
    opener(site).focus(); expect(document.activeElement, "background cannot receive focus").toBe(active);
    expect(sheet(site)!.getBoundingClientRect().width, "the modal escapes its 280px size container").toBe(width);
    expect(sheet(site)!.closest<HTMLElement>('[data-theme]')!.dataset.theme, "the sheet inherits its subtree theme").toBe(theme);
  });
  test(`sheet Tab wraps inside: ${scene}`, async () => {
    await mount(site, width, theme); await open(site);
    const items = stops(site); expect(items.length, "nonempty trap").toBeGreaterThan(1);
    items.at(-1)!.focus(); await userEvent.tab();
    expect(document.activeElement, "forward Tab wraps to first content stop").toBe(items[0]);
    await userEvent.tab({ shift: true });
    expect(document.activeElement, "reverse Tab wraps to last content stop").toBe(items.at(-1));
    for (let i = 0; i < 6; i++) {
      await userEvent.tab(); expect(sheet(site)!.contains(document.activeElement), "Tab stays in the sheet").toBe(true);
    }
  });
  test(`sheet Escape closes only the topmost and returns each opener: ${scene}`, async () => {
    await mount(site, width, theme); await open(site);
    const lowerFocus = stops(site)[0]!;
    lowerFocus.focus();
    // Open the second modal programmatically while the first makes the page
    // inert. Keyboard dismissal itself goes through real Chromium input.
    host!.querySelector<HTMLButtonElement>('[data-upper-opener]')!.click();
    await expect.poll(() => host!.querySelector('dialog[aria-label="Review raft"]')).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(sheet(site), "the underlying sheet remains open").not.toBeNull();
    await expect.poll(() => host!.querySelector('dialog[aria-label="Review raft"]'), { message: "topmost review closes" }).toBeNull();
    await expect.poll(() => document.activeElement, { message: "upper dismissal restores the lower opener" }).toBe(lowerFocus);
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => sheet(site), { message: "second Escape closes the sheet" }).toBeNull();
    await expect.poll(() => document.activeElement, { message: "sheet dismissal returns its own opener" }).toBe(opener(site));
  });
  test(`sheet contents and caller actions are retained: ${scene}`, async () => {
    const actions = await mount(site, width, theme); await open(site);
    if (site === "working") {
      const rows = stops(site); expect(rows, "every working session is retained").toHaveLength(4);
      rows[0]!.focus(); await userEvent.keyboard('{Enter}');
      expect(actions.working, "activation opens exactly the named session").toHaveBeenCalledExactlyOnceWith(workingSessions[0]!.id);
      await expect.poll(() => sheet(site)).toBeNull();
      await expect.poll(() => document.activeElement, { message: "session navigation retains caller focus" }).toBe(host!.querySelector('[data-session-destination]'));
    } else if (site === "pending") {
      expect(stops(site).map(row => row.querySelector('.bk-pending-full')!.textContent), "follow-ups retain full text in send order").toEqual(pendingFollowUps.slice(0, 4).map(f => f.text));
      expect(sheet(site)!.querySelectorAll('button, [role="button"]'), "review stays read-only").toHaveLength(0);
    } else {
      const models = sheet(site)!.querySelectorAll<HTMLInputElement>('input[data-model]');
      await userEvent.click(models[1]!);
      expect(actions.model, "model selection stays live").toHaveBeenCalledExactlyOnceWith("sail");
      expect(sheet(site), "model selection keeps the picker open").not.toBeNull();
      const effort = sheet(site)!.querySelector<HTMLInputElement>('input[data-effort][value="default"]')!;
      effort.focus(); await userEvent.keyboard('{ArrowDown}{ArrowDown}');
      expect(actions.effort, "arrow browsing does not commit effort").not.toHaveBeenCalled();
      await userEvent.keyboard('{Enter}');
      expect(actions.effort, "Enter commits the preview effort").toHaveBeenCalledExactlyOnceWith("medium");
      await expect.poll(() => sheet(site), { message: "caller may close after committing effort" }).toBeNull();
    }
  });
}
