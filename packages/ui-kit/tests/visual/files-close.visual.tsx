import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { BrainUiProvider, useRootStore } from "../../../ui-react/src/root-context.js";
import { FilePanel } from "../../../ui-react/src/components/files/file-panel.js";
import { fileTree } from "../../fixtures/files.js";

const entries = fileTree.filter((node) => node.depth === 0).map((node) => ({
  name: node.label,
  path: node.label,
  type: "dir" as const,
}));

function Files() {
  const open = useRootStore("ui", (state) => state.filePanelOpen);
  const close = useRootStore("ui", (state) => state.setFilePanelOpen);
  return <FilePanel open={open} onClose={() => close(false)} />;
}

for (const theme of ["dark", "light"]) {
  for (const width of [390, 480, 900]) {
    for (const input of ["pointer", "Enter", "Space"] as const) {
      test(`Files close is named and dismisses with ${input} in ${theme} at ${width}px`, async () => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const browserViewport = await commands.formViewport(width, 800);
        const previousTheme = document.documentElement.dataset.theme;
        const previousUrl = window.location.href;
        const style = document.createElement("style");
        const host = document.createElement("div");
        const ui = createBrainUiRoot({ storage: null, request: async () => {
          throw new Error("The seeded public Files fixture must not request data");
        } });
        const react = createRoot(host);
        try {
          await page.viewport(width, 800);
          document.documentElement.dataset.theme = theme;
          style.textContent = await commands.formConsumerStyles();
          style.textContent += "\n*, *::before, *::after { animation: none !important; transition: none !important; }";
          document.head.append(style);
          document.body.append(host);
          ui.stores.file.setState({ dirCache: { "": entries } });
          ui.stores.ui.getState().setFilePanelOpen(true);
          flushSync(() => react.render(<BrainUiProvider root={ui}><Files /></BrainUiProvider>));

          // A populated, actually open FilePanel is the positive control.
          expect(entries.length).toBeGreaterThan(0);
          await expect.poll(() => host.querySelectorAll('[role="treeitem"]').length).toBe(entries.length);
          expect(host.textContent).toContain("voyage");
          expect(ui.stores.ui.getState().filePanelOpen).toBe(true);
          expect(window.matchMedia("(min-width: 900px)").matches).toBe(width >= 900);

          const close = page.elementLocator(host).getByRole("button", {
            name: width < 900 ? "Close Files" : "Close",
            exact: true,
          });
          // This lookup must fail if the actual drawer header loses its name.
          expect(close.query(), "actual named Files close control").not.toBeNull();
          await expect.element(close).toBeVisible();
          const button = close.element() as HTMLButtonElement;
          if (input === "pointer") {
            await userEvent.click(close);
          } else {
            button.focus();
            expect(document.activeElement).toBe(button);
            await userEvent.keyboard(input === "Enter" ? "{Enter}" : " ");
          }
          await expect.poll(() => ui.stores.ui.getState().filePanelOpen).toBe(false);
          await expect.poll(() => host.querySelectorAll('[role="treeitem"]').length).toBe(0);
        } finally {
          flushSync(() => react.unmount());
          ui.dispose();
          host.remove();
          style.remove();
          if (previousTheme === undefined) delete document.documentElement.dataset.theme;
          else document.documentElement.dataset.theme = previousTheme;
          history.replaceState(null, "", previousUrl);
          await page.viewport(viewport.width, viewport.height);
          await commands.formViewport(browserViewport.width - 100, browserViewport.height - 120);
        }
      });
    }
  }
}
