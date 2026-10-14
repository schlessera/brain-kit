import preview from "#.storybook/preview";
import { useEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../../ui-react/src/root.js";
import { FilePanel } from "../../../ui-react/src/components/files/file-panel.js";
import { rememberFileEntry } from "../../../ui-react/src/lib/file-entry-focus.js";
import type { FileLoadFailure } from "../../../ui-react/src/stores/file-state.js";
import { ConsumerDocument, consumerViewport, painted, bounds, accessible } from "./_consumer-parity.js";

const path = ".brain/scratch/raft/overview.pdf";
const roots = new WeakMap<Element, BrainUiRoot>();
function ArtifactTheme({ onRetry }: { width: number; onRetry: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [root] = useState(() => {
    const root = createBrainUiRoot({ storage: null, request: async url => {
      if (String(url).includes("/files/tree")) return Response.json({ path: "", entries: [] });
      throw new Error(`Unexpected artifact fixture request: ${url}`);
    } });
    root.stores.file.setState({ dirCache: { "": [] }, retryFile: onRetry });
    return root;
  });
  useEffect(() => { const url = location.href; return () => { root.dispose(); history.replaceState(null, "", url); }; }, [root]);
  return <ConsumerDocument><BrainUiProvider root={root}>
    <div data-artifact-theme ref={element => { if (element) roots.set(element, root); }}>
      <button onClick={event => {
        rememberFileEntry(root, event.currentTarget, true);
        root.stores.file.setState({ currentPath: path, currentContent: null, contentLoading: true, treeExpanded: false });
        setOpen(true);
      }}>Open raft overview</button>
      <FilePanel open={open} onClose={() => setOpen(false)} />
    </div>
  </BrainUiProvider></ConsumerDocument>;
}

const meta = preview.meta({
  title: "Conversation/Artifact theme", component: ArtifactTheme,
  parameters: { layout: "fullscreen" }, beforeEach: consumerViewport,
  args: { width: 320, onRetry: fn(async () => {}) },
});
export const Phone = meta.story({
  play: async ({ args, userEvent, globals, canvasElement }) => {
    await painted(args.width, globals.theme);
    const screen = within(document.body);
    const root = roots.get(canvasElement.querySelector("[data-artifact-theme]")!)!;
    const opener = screen.getByRole("button", { name: "Open raft overview" });
    opener.focus(); await userEvent.keyboard("{Enter}");
    await screen.findByLabelText("Loading file");
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-file-title]")));
    await expect(document.querySelectorAll("[data-panel=Files]")).toHaveLength(args.width < 900 ? 1 : 0);
    await expect(document.querySelectorAll('section[aria-label="Files"]')).toHaveLength(args.width >= 900 ? 1 : 0);
    const ghosts = [...document.querySelectorAll(".bk-ghost")];
    await expect(ghosts.length).toBeGreaterThan(0);
    for (const ghost of ghosts) await expect(getComputedStyle(ghost).animationName, "static reduced-motion loading").toBe("none");
    await expect(screen.getAllByRole("status")).toHaveLength(1);
    await accessible(canvasElement);
    const states: Array<[FileLoadFailure["kind"], string, boolean]> = [
      ["unknown", "Couldn't open this file.", true],
      ["unreachable", "Can't reach your brain right now.", true],
      ["forbidden", "This file isn't available with your current access.", false],
      ["too-large", "Too large to preview here.", false],
    ];
    for (const [kind, title, retry] of states) {
      root.stores.file.setState({ contentLoading: false, contentError: title, contentFailure: { kind } });
      await screen.findByRole("heading", { name: title });
      await expect(screen.getAllByRole("status")).toHaveLength(1);
      await expect(screen.queryAllByRole("alert")).toHaveLength(0);
      await expect(screen.queryAllByRole("button", { name: "Try again" })).toHaveLength(retry ? 1 : 0);
      await expect(document.querySelectorAll("a[download]")).toHaveLength(0);
      await bounds(document.querySelector<HTMLElement>("[data-file-title]")!.parentElement!.parentElement!, `${kind} toolbar`);
      await accessible(canvasElement);
      if (retry) {
        const button = screen.getByRole("button", { name: "Try again" });
        await expect(button.getBoundingClientRect().height, "artifact retry target height").toBeGreaterThanOrEqual(44);
        await expect(button.getBoundingClientRect().width, "artifact retry target width").toBeGreaterThanOrEqual(44);
        await bounds(button, `${kind} retry`);
        await userEvent.click(button);
        await expect(args.onRetry).toHaveBeenCalledTimes(kind === "unknown" ? 1 : 2);
        await expect(document.activeElement).toBe(document.querySelector("[data-file-title]"));
      }
    }
    // PDF parsing/painting and raw-route responses retain their native runtime
    // oracle. This state proves the same actual PDF consumer composition too.
    root.stores.file.setState({ contentError: null, contentFailure: null, currentContent: { path, kind: "binary", mime: "application/pdf", size: 700, mtime: Date.UTC(2026, 6, 12) } });
    await waitFor(() => expect(document.querySelector("canvas")?.width).toBeGreaterThan(0), { timeout: 15000 });
    await expect(screen.getAllByRole("status")).toHaveLength(1);
    await expect(screen.queryAllByRole("alert")).toHaveLength(0);
    await expect(screen.queryAllByRole("button", { name: "Try again" })).toHaveLength(0);
    await bounds(document.querySelector<HTMLCanvasElement>("canvas")!, "PDF preview");
    await accessible(canvasElement);
    root.stores.file.setState({ currentContent: null, contentExpired: true });
    await screen.findByRole("heading", { name: "This file has expired" });
    await expect(screen.getAllByRole("status")).toHaveLength(1);
    await expect(screen.queryAllByRole("alert")).toHaveLength(0);
    await expect(screen.queryAllByRole("button", { name: "Try again" })).toHaveLength(0);
    await expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    await accessible(canvasElement);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await expect(document.querySelector("[data-file-title]")).toBeNull();
    await userEvent.click(opener); // Keep named loading for the addon gate.
    await screen.findByLabelText("Loading file");
  },
});
export const Desktop = Phone.extend({ args: { width: 1280 } });
