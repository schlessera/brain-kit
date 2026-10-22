import preview from "#.storybook/preview";
import { useEffect, useState, type ReactElement } from "react";
import { expect, waitFor, within } from "storybook/test";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../../ui-react/src/root.js";
import { BrainMarkdown } from "../../../ui-react/src/components/chat/brain-markdown.js";
import { FilePanel } from "../../../ui-react/src/components/files/file-panel.js";
import { useUIStore } from "../../../ui-react/src/stores/ui-store.js";
import { ConsumerDocument, consumerViewport, painted, bounds, accessible } from "./_consumer-parity.js";

const path = ".brain/scratch/raft/overview.pdf";
/** Metadata outcomes the runtime routes return, served through the root's
 * request seam so the real file store classifies each one. */
type Outcome = "held" | "offline" | 200 | 403 | 404 | 413 | 500;
type Fixture = { root: BrainUiRoot; next: Outcome; metadata: number; release?: () => void };
const fixtures = new WeakMap<Element, Fixture>();

function Scene() {
  const open = useUIStore(s => s.filePanelOpen);
  const close = useUIStore(s => s.setFilePanelOpen);
  return <>
    <h1 data-chat-heading="" tabIndex={-1}>The voyage</h1>
    <article aria-label="Conversation" style={{ margin: "24px 0" }}>
      <BrainMarkdown content={`The crossing at Scylla is recorded in [the raft overview](${path}).`} fileLinks />
    </article>
    <textarea data-composer="" aria-label="Message" defaultValue="Ask Penelope about the shroud." style={{ display: "block", maxWidth: "100%" }} />
    <FilePanel open={open} onClose={() => close(false)} />
  </>;
}

/** The composition of `artifact-recovery-client.tsx`, with its page's inline
 * article and textarea rules, without the connection gate and navigation
 * chrome, which keep their runtime owners. */
/** `width` drives the consumer viewport in `artifactFixture`, not the render. */
const ArtifactTheme: (props: { width: number }) => ReactElement = () => {
  const [fixture] = useState(() => {
    const fixture = { next: 500, metadata: 0 } as Fixture;
    fixture.root = createBrainUiRoot({ storage: null, request: async (input, init) => {
      const url = new URL(String(input), location.href);
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/files/content") && url.searchParams.get("path") === path) {
        // The scratch reference check and the preview confirmation find the file.
        if (url.searchParams.get("raw") === "1" && method === "HEAD") return new Response(null, { status: 200 });
        if (!url.searchParams.has("raw") && method === "GET") {
          fixture.metadata++;
          const outcome = fixture.next;
          if (outcome === "held") { await new Promise<void>(resolve => { fixture.release = resolve; }); return Response.json({}, { status: 500 }); }
          if (outcome === "offline") throw new TypeError("Failed to fetch");
          if (outcome === 200) return Response.json({ path, kind: "binary", mime: "application/pdf", size: 700, mtime: Date.UTC(2026, 6, 12) });
          return Response.json({ error: "private backend detail" }, { status: outcome });
        }
      }
      if (url.pathname.endsWith("/files/resolve")) return Response.json({ path: url.searchParams.get("path"), ancestors: [], exists: true, type: "file" });
      if (url.pathname.endsWith("/files/tree")) return Response.json({ path: "", entries: [] });
      throw new Error(`Unexpected artifact fixture request: ${method} ${url.pathname}${url.search}`);
    } });
    return fixture;
  });
  useEffect(() => {
    const url = location.href;
    return () => { fixture.release?.(); fixture.root.dispose(); history.replaceState(null, "", url); };
  }, [fixture]);
  return <ConsumerDocument><BrainUiProvider root={fixture.root}>
    <div data-artifact-theme ref={element => { if (element) fixtures.set(element, fixture); }}><Scene /></div>
  </BrainUiProvider></ConsumerDocument>;
};

/** The consumer viewport, plus the native PDF bytes for the success state. */
async function artifactFixture(context: { args: { width: number } }) {
  const viewport = await consumerViewport(context);
  if (!viewport) return;
  const { commands } = await import("vitest/browser");
  const { onTestFinished } = await import("vitest");
  let removed = false;
  const remove = async () => {
    if (removed) return;
    removed = true;
    await commands.artifactParityRoute(null);
  };
  onTestFinished(remove);
  await commands.artifactParityRoute(path);
  return async () => {
    const errors: unknown[] = [];
    try { await remove(); } catch (error) { errors.push(error); }
    try { await viewport(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Artifact fixture cleanup failed");
  };
}

async function opened(canvasElement: HTMLElement, width: number, theme: string | undefined) {
  await painted(width, theme);
  const fixture = fixtures.get(canvasElement.querySelector("[data-artifact-theme]")!)!;
  const screen = within(document.body);
  const link = screen.getByRole("link", { name: "the raft overview" });
  await waitFor(() => expect(fixture.root.stores.file.getState().scratchFiles[path]).toBe("present"));
  return { fixture, screen, link };
}

/** One shape is mounted per width; it renders inline, inside this consumer document. */
async function owned(canvasElement: HTMLElement, width: number, theme: string | undefined) {
  await expect(document.querySelectorAll("[data-panel=Files]"), "phone drawer").toHaveLength(width < 900 ? 1 : 0);
  await expect(document.querySelectorAll('section[aria-label="Files"]'), "desktop panes").toHaveLength(width >= 900 ? 1 : 0);
  const panel = document.querySelector<HTMLElement>(width < 900 ? "[data-panel=Files]" : 'section[aria-label="Files"]')!;
  await expect(panel.getRootNode(), "artifact panel is not portalled into another root").toBe(document);
  await expect(canvasElement.contains(panel), "artifact panel stays inside the consumer document").toBe(true);
  await expect(getComputedStyle(panel).colorScheme, "artifact panel paints the selected theme").toBe(theme);
  return panel;
}

async function neutral(screen: ReturnType<typeof within>, retry: boolean) {
  await expect(screen.getAllByRole("status"), "exactly one artifact status").toHaveLength(1);
  await expect(screen.queryAllByRole("alert"), "artifact states are not alerts").toHaveLength(0);
  await expect(screen.queryAllByRole("button", { name: "Try again" }), "retry only where supported").toHaveLength(retry ? 1 : 0);
  await expect(document.documentElement.scrollWidth, "artifact document bounds").toBeLessThanOrEqual(innerWidth);
}

const meta = preview.meta({
  title: "Conversation/Artifact theme", component: ArtifactTheme,
  parameters: { layout: "fullscreen" }, beforeEach: artifactFixture,
  args: { width: 320 },
});

/** `artifact layout <theme> <width>` in artifact-recovery-runtime: a 500 reached
 * by keyboard, its bounded retry, 200% zoom and Escape back to the link. */
export const LayoutPhone = meta.story({
  play: async ({ args, userEvent, globals, canvasElement }) => {
    const { fixture, screen, link } = await opened(canvasElement, args.width, globals.theme);
    link.focus(); await userEvent.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "Couldn't open this file." });
    await waitFor(() => expect(document.activeElement, "artifact title focus").toBe(document.querySelector("[data-file-title]")));
    const panel = await owned(canvasElement, args.width, globals.theme);
    await neutral(screen, true);
    await expect(document.querySelectorAll("a[download]"), "no false download").toHaveLength(0);
    await expect(screen.queryByText("private backend detail"), "server detail stays private").toBeNull();
    const retry = screen.getByRole("button", { name: "Try again" });
    const box = retry.getBoundingClientRect();
    await expect(box.height, "artifact retry target height").toBeGreaterThanOrEqual(44);
    await expect(box.width, "artifact retry target width").toBeGreaterThanOrEqual(44);
    // The runtime's own oracle: the document's layout hit test at each edge.
    for (const [x, y] of [[box.left + 1, box.top + box.height / 2], [box.right - 1, box.top + box.height / 2], [box.left + box.width / 2, box.top + 1], [box.left + box.width / 2, box.bottom - 1]] as const) {
      await expect(retry.contains(document.elementFromPoint(x, y)), `artifact retry edge hit test at ${Math.round(x)},${Math.round(y)}`).toBe(true);
    }
    await bounds(retry, "artifact retry");
    await bounds(document.querySelector<HTMLElement>("[data-file-title]")!.closest<HTMLElement>(".border-b")!, "artifact toolbar");
    await accessible(panel);
    // Retry repeats exactly one load and keeps the title as the focus stop.
    const before = fixture.metadata;
    await userEvent.click(retry);
    await screen.findByRole("heading", { name: "Couldn't open this file." });
    await expect(fixture.metadata, "one retry flight").toBe(before + 1);
    await expect(document.activeElement, "retry keeps title focus").toBe(document.querySelector("[data-file-title]"));
    const zoom = document.documentElement.style.zoom;
    document.documentElement.style.zoom = "2";
    try {
      await expect(document.documentElement.scrollWidth, "artifact 200% zoom has no horizontal overflow").toBeLessThanOrEqual(document.documentElement.clientWidth);
      await expect(screen.getByRole("button", { name: "Try again" }), "artifact retry visible at 200% zoom").toBeVisible();
    } finally { document.documentElement.style.zoom = zoom; }
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement, "Escape returns to the file link").toBe(link));
    await expect(fixture.root.stores.ui.getState().filePanelOpen, "artifact panel closed").toBe(false);
    await expect(document.querySelector("[data-file-title]")).toBeNull();
  },
});
export const LayoutDesktop = LayoutPhone.extend({ args: { width: 1280 } });

/** `artifact full state matrix <theme> <width>`: held loading, then each
 * failure, the PDF and the expired file, in the runtime's order. */
export const StatesPhone = meta.story({
  play: async ({ args, userEvent, globals, canvasElement }) => {
    const { fixture, screen, link } = await opened(canvasElement, args.width, globals.theme);
    fixture.next = "held";
    link.focus(); await userEvent.keyboard("{Enter}");
    const loading = await screen.findByLabelText("Loading file");
    await expect(screen.getByRole("status"), "named loading status").toHaveTextContent("Loading file");
    const panel = await owned(canvasElement, args.width, globals.theme);
    // Axe owns the loading wrapper's semantics (#1884) before its role is read.
    await accessible(panel);
    await expect(loading, "loading is a named group").toHaveRole("group");
    const ghosts = [...panel.querySelectorAll<HTMLElement>(".bk-ghost")];
    await expect(ghosts.length, "loading draws ghost lines").toBeGreaterThan(0);
    for (const ghost of ghosts) await expect(getComputedStyle(ghost).animationName, "static reduced-motion loading").toBe("none");
    await neutral(screen, false);
    await bounds(loading, "artifact loading");
    fixture.release!();
    await screen.findByRole("heading", { name: "Couldn't open this file." });
    await neutral(screen, true);
    await accessible(panel);
    const states: Array<[Outcome, string, boolean]> = [
      ["offline", "Can't reach your brain right now.", true],
      [403, "This file isn't available with your current access.", false],
      [413, "Too large to preview here.", false],
      [200, "overview.pdf", false],
      [404, "This file has expired", false],
    ];
    for (const [outcome, title, retry] of states) {
      fixture.next = outcome;
      void fixture.root.stores.file.getState().openFile(path);
      await screen.findByRole("heading", { name: title });
      if (outcome === 200) {
        // Settle on either outcome, so a PDF that never paints fails by name.
        await waitFor(() => expect((panel.querySelector("canvas")?.width ?? 0) > 0 || panel.textContent!.includes("Preview not available")).toBe(true), { timeout: 10_000 });
        await expect(panel.querySelector("canvas")?.width ?? 0, "PDF page painted").toBeGreaterThan(0);
        await bounds(panel.querySelector("canvas")!, "PDF preview");
      } else {
        await waitFor(() => expect(fixture.root.stores.file.getState().contentLoading).toBe(false));
        await expect(document.querySelectorAll("a[download]"), `${title}: no false download`).toHaveLength(0);
      }
      await neutral(screen, retry);
      await accessible(panel);
    }
    // The expired state stays for the unchanged addon accessibility gate.
  },
});
export const StatesDesktop = StatesPhone.extend({ args: { width: 1280 } });
