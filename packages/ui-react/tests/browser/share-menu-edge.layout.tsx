// Share menu alignment at clipped lane edges (#3536).
import { afterEach, expect, test } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ShareMenu } from "../../src/components/share/share-menu.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement | undefined;
afterEach(() => { if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); styles?.remove(); });

const options = [
  { id: "png", label: "Image (PNG)", run: async () => true },
  { id: "pdf", label: "PDF", run: async () => true },
  { id: "svg", label: "Vector (SVG)", run: async () => true },
];

test("a share menu opened near the left of a clipped lane stays inside it; one near the right keeps hanging from its right edge", async () => {
  styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles);
  root = createBrainUiRoot({ storage: null }); host = document.createElement("div"); document.body.append(host); renderer = createRoot(host);
  // The chat's content lane clips; a diagram's controls put the share trigger at its left.
  host.style.cssText = "position:absolute;left:40px;top:40px;width:320px;height:240px;overflow:hidden";
  for (const justify of ["flex-start", "flex-end"] as const) {
    flushSync(() => renderer!.render(<BrainUiProvider root={root!}><div style={{ display: "flex", justifyContent: justify, padding: 8 }}><ShareMenu title="Share diagram" options={options} /></div></BrainUiProvider>));
    await userEvent.click(host.querySelector('button[aria-haspopup="menu"]')!);
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!; expect(menu).not.toBeNull();
    await expect.poll(() => menu.dataset.align).toBe(justify === "flex-start" ? "start" : "end");
    const lane = host.getBoundingClientRect(), box = menu.getBoundingClientRect();
    expect(box.left, `MENU_INSIDE_LANE_LEFT ${justify}`).toBeGreaterThanOrEqual(lane.left - 0.5);
    expect(box.right, `MENU_INSIDE_LANE_RIGHT ${justify}`).toBeLessThanOrEqual(lane.right + 0.5);
    await userEvent.keyboard("{Escape}");
  }
});
