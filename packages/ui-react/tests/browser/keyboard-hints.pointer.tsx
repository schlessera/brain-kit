import { afterEach, expect, inject, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Composer, SideRail as KitSideRail } from "@schlessera/brain-ui-kit";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import { SideRail } from "../../src/components/layout/side-rail.js";
import { DesktopPalette } from "../../src/components/layout/desktop-palette.js";
import { MobileTabBar } from "../../src/components/layout/mobile-tab-bar.js";
import { FilePanel } from "../../src/components/files/file-panel.js";

let renderer: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined, style: HTMLStyleElement | undefined;
let viewport: { width: number; height: number }, outer: { width: number; height: number };
const themeBefore = document.documentElement.dataset.theme;
const urlBefore = location.href;
afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose(); host?.remove(); style?.remove();
  renderer = undefined; ui = undefined; host = undefined; style = undefined;
  if (themeBefore === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = themeBefore;
  history.replaceState(null, "", urlBefore);
  await page.viewport(viewport.width, viewport.height);
  await commands.formViewport(outer.width - 100, outer.height - 120);
});
function Scene() {
  const files = useUIStore(s => s.filePanelOpen);
  const close = useUIStore(s => s.setFilePanelOpen);
  return <><SideRail /><DesktopPalette /><MobileTabBar /><FilePanel open={files} onClose={() => close(false)} /></>;
}
async function tap(el: HTMLElement) {
  if (inject("railPointer") === "fine") await userEvent.click(el);
  else {
    const rect = el.getBoundingClientRect();
    await commands.rankTap({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }
}
declare module "vitest" {
  interface ProvidedContext { keyboardHintsLive: boolean; }
}
const live = inject("keyboardHintsLive") === true;
for (const width of live ? [1280] : [320, 600, 1280]) {
  test(`${width}: printed keys follow the real pointer while tap and keyboard actions work`, async () => {
    const fine = inject("railPointer") !== "coarse";
    expect(matchMedia("(any-pointer: fine)").matches, "actual pointer premise").toBe(fine);
    viewport = { width: innerWidth, height: innerHeight };
    outer = await commands.formViewport(width, 800); await page.viewport(width, 800);
    document.documentElement.dataset.theme = "light";
    style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
    host = document.createElement("div"); document.body.append(host);
    ui = createBrainUiRoot({ storage: null, request: async url => {
      const path = new URL(String(url), location.origin).searchParams.get("path");
      return Response.json({ path, kind: "markdown", content: "# Return to Ithaca", size: 18 });
    } });
    ui.stores.file.setState({ dirCache: { "": [{ name: "return.md", path: "voyage/return.md", type: "file" }, { name: "circe.md", path: "people/circe.md", type: "file" }] } });
    renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={ui}><Scene /><Composer value="" onSend={() => {}} /></BrainUiProvider>));
    const composerHint = host.querySelector<HTMLElement>('[data-composer-hint]')!;
    if (width >= 480) {
      const all = page.getByRole("button", { name: "All commands" });
      await tap(all.element() as HTMLElement);
      const dialog = page.getByRole("dialog", { name: "Command palette" });
      await expect.element(dialog).toBeVisible();
      const el = dialog.element() as HTMLElement;
      expect(el.innerText.includes("esc"), "palette Escape hint").toBe(fine);
      expect(el.innerText.includes("⏎"), "palette Enter fallback and footer").toBe(fine);
      expect(el.innerText.includes("⌘4"), "palette explicit destination hint").toBe(fine);
      await page.getByRole("combobox").fill("Graph");
      expect((page.getByRole("option", { name: "Graph" }).element() as HTMLElement).innerText.includes("⏎"), "selected-row generated fallback").toBe(fine);
      await page.getByRole("combobox").fill("");
      expect(el.scrollWidth, "picker fits").toBeLessThanOrEqual(el.clientWidth + 1);
      await page.screenshot({ path: `../../.vitest-attachments/keyboard-hints/${width}-${inject("railPointer")}-palette.png` });
      await userEvent.keyboard("{Escape}");
      await expect.element(dialog).not.toBeInTheDocument();
      await tap(all.element() as HTMLElement);
      await page.getByRole("combobox").fill("Files");
      await userEvent.keyboard("{Enter}");
    } else {
      await tap(page.getByRole("tab", { name: "Files" }).element() as HTMLElement);
    }
    expect(composerHint.getBoundingClientRect().height > 0 && composerHint.innerText.includes("⏎"), "composer keys").toBe(fine);
    await expect.poll(() => ui!.stores.ui.getState().filePanelOpen).toBe(true);
    const tree = page.getByRole("treeitem", { name: /return.md/ });
    await expect.element(tree).toBeVisible();
    if (width >= 900) {
      const files = host.querySelector<HTMLElement>('section[aria-label="Files"]')!;
      expect(files.innerText.includes("← → fold"), "file instruction footer").toBe(fine);
      expect(files.innerText.includes("j / k move"), "single-key instruction footer").toBe(fine);
      (tree.element() as HTMLElement).focus();
      await userEvent.keyboard("j");
      expect(document.activeElement).toBe(page.getByRole("treeitem", { name: /circe.md/ }).element());
      await userEvent.keyboard("k");
      expect(document.activeElement).toBe(tree.element());
      flushSync(() => ui!.stores.ui.getState().setSingleKeyShortcuts(false));
      expect(files.innerText).not.toContain("j / k move");
      expect(files.innerText.includes("← → fold")).toBe(fine);
    }
    if (live) {
      await commands.dictationPointer(true);
      await expect.poll(() => matchMedia("(any-pointer: fine)").matches, { message: "live native media change" }).toBe(false);
      await expect.poll(() => host!.innerText.includes("← → fold"), { message: "live Files footer removal" }).toBe(false);
      expect(composerHint.getBoundingClientRect().height, "live composer legend removes its row").toBe(0);
      flushSync(() => ui!.stores.ui.getState().setFilePanelOpen(false));
      await userEvent.click(page.getByRole("button", { name: "All commands" }).element());
      const dialog = page.getByRole("dialog", { name: "Command palette" });
      await expect.element(dialog).toBeVisible();
      expect((dialog.element() as HTMLElement).innerText).not.toMatch(/esc|⏎|⌘/);
      await userEvent.keyboard("{Escape}");
      flushSync(() => ui!.stores.ui.getState().setFilePanelOpen(true));
      await expect.element(tree).toBeVisible();
    }
    await page.screenshot({ path: `../../.vitest-attachments/keyboard-hints/${width}-${inject("railPointer")}-files.png` });
    // Enter operates the real tree row even when its legend is suppressed.
    (tree.element() as HTMLElement).focus(); await userEvent.keyboard("{Enter}");
    await expect.poll(() => ui!.stores.file.getState().currentPath).toBe("voyage/return.md");
    // Standalone embedders need the kit's own explicit-key gate too.
    flushSync(() => renderer!.render(<KitSideRail expanded items={[{ icon: "files", label: "Ithaca", shortcut: "⌘9" }]} spendPct={null} hint={null} />));
    expect(host.innerText).toContain("Ithaca");
    expect(host.innerText.includes("⌘9"), "standalone rail destination key").toBe(live ? false : fine);
  });
}
