import { Suspense, useEffect, useRef, type RefObject } from "react";
import { Button, Overlay, TextButton, Label, Receipt, ScreenHeader } from "@schlessera/brain-ui-kit";
import type { ReceiptRow } from "@schlessera/brain-ui-kit";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useFileStore } from "../../stores/file-store.js";
import { singleKey } from "../../lib/single-key.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { splitFrontmatter } from "../../lib/frontmatter.js";
import { cn } from "../../lib/utils.js";
import { formatSize } from "./file-viewer-frame.js";
import { DisabledToggleRow } from "../graph/graph-form.js";
import { useDestinationPress } from "../../hooks/use-destination-press.js";
import { focusFirst, scrollToStart, openModal } from "../../lib/destination-start.js";
import { STALE_AFTER_DAYS, ageInDays, formatAge } from "./staleness.js";
import { lazyChunk } from "../../lib/lazy-chunk.js";

/**
 * The `laptop:` breakpoint from `theme.css`. From here up the rail is
 * expanded and the design's D3 draws Files as panes beside it; below, the
 * drawer. Read as a media query rather than a class pair so only one of the
 * two shapes is mounted — two would mean two file trees on the store.
 */
const PANES_QUERY = "(min-width: 900px)";

/**
 * The tree and the viewers load the first time the panel is opened. Together
 * they carry the markdown, HTML, image and PDF viewers, none of which the chat
 * surface needs to have on hand.
 */
const FileTree = lazyChunk(() => import("./file-tree.js").then((m) => ({ default: m.FileTree })));
const FileViewer = lazyChunk(() => import("./file-viewer.js").then((m) => ({ default: m.FileViewer })));

export function FilePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const currentPath = useFileStore((s) => s.currentPath);
  const treeExpanded = useFileStore((s) => s.treeExpanded);
  const setTreeExpanded = useFileStore((s) => s.setTreeExpanded);
  const closeFile = useFileStore((s) => s.closeFile);
  const panes = useMediaQuery(PANES_QUERY);

  useEffect(() => {
    if (!open || !panes) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || openModal()) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, panes, onClose]);

  // Sync hash route to current file. When the panel closes, strip the
  // `#/files*` segment entirely so a reload doesn't reopen it.
  useEffect(() => {
    if (!open) {
      if (window.location.hash.startsWith("#/files")) {
        // Replace with the pathname (no hash) so reload lands on the chat.
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      return;
    }
    if (currentPath) {
      const target = `#/files/${currentPath}`;
      if (window.location.hash !== target) {
        history.replaceState(null, "", target);
      }
    } else if (window.location.hash.startsWith("#/files")) {
      history.replaceState(null, "", "#/files");
    }
  }, [open, currentPath]);

  const showContent = open;
  const showTree = open && (!currentPath || treeExpanded);

  // Pressing Files while it is open (D52 N3): the viewer goes to the top of
  // the file (an HTML preview by reloading) and the tree box to its top, and
  // focus goes to the open file's tree row. With the tree hidden it goes to
  // the reading pane's title, and with no file open to the Files heading;
  // the panes have no title stop. The tree's own reveal (a smooth, centred
  // scroll) is not asked for.
  const panelRef = useRef<HTMLElement>(null);
  useDestinationPress("files", ({ keyboard }) => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    scrollToStart(panel);
    // A sandboxed HTML preview scrolls inside a document the panel cannot
    // reach; loading the same source again shows the top of the file, and
    // brings back a preview that navigated itself away (#1084).
    for (const frame of panel.querySelectorAll<HTMLIFrameElement>("iframe[data-html-preview]")) {
      const src = frame.getAttribute("src");
      if (src !== null) frame.setAttribute("src", src);
    }
    const el = (sel: string) => panel.querySelector<HTMLElement>(sel);
    focusFirst([
      el('[role="treeitem"][aria-selected="true"]'),
      panes ? null : el("[data-file-title]"),
      el("[data-destination-heading]"),
    ], keyboard);
  });

  if (panes) {
    return open ? <FilePanes onClose={onClose} panelRef={panelRef} /> : null;
  }

  return (
    <Overlay open={open} variant="panel" modal={false} size="lg" title="Files" data-panel="Files"
      onClose={onClose} surfaceRef={panelRef}>
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Tree toggle strip — visible when a file is open */}
          {showContent && currentPath && (
            <div className="flex items-center gap-1 border-b border-border bg-surface-raised/40 px-3 py-1.5">
              <TextButton tone="meta" label={treeExpanded ? "Hide tree" : "Show tree"} expanded={treeExpanded} glyph={treeExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} onClick={() => setTreeExpanded(!treeExpanded)} />
              <TextButton tone="meta" label="Close file" onClick={closeFile} style={{ marginLeft: "auto" }} />
            </div>
          )}

          {/* Tree area */}
          {showTree && (
            <div
              className={cn(
                "overflow-y-auto",
                currentPath ? "max-h-[45vh] border-b border-border" : "flex-1"
              )}
            >
              <Suspense fallback={null}>
                <FileTree />
              </Suspense>
            </div>
          )}

          {/* Viewer area */}
          {showContent && currentPath && (
            <div className="flex-1 overflow-hidden">
              <Suspense fallback={null}>
                <FileViewer />
              </Suspense>
            </div>
          )}
        </div>
    </Overlay>
  );
}

/**
 * D3 (the fifth design drop): from `laptop:` up Files is
 * not a drawer but a layer of panes over the content area, beside the rail —
 * a 300px tree, the reading pane at a 720px measure, and from `wide:` a
 * 320px evidence rail. No backdrop: the rail stays reachable, and the layer
 * is the app's own surface, not a sheet over it. The host still composes
 * views, so this remains the same `FilePanel` the drawer is; only the shape
 * changes with the width.
 *
 * The tree's title carries no document count: the file store has no total,
 * and the design's `4,812 docs` is not something to make up.
 *
 * The footer prints the keys that fire. `j` / `k` are single-key letters
 * and go with the Settings off switch (D37 — a key that does not fire is
 * not advertised); `← →` and `⏎` are not letters, the switch does not
 * cover them, and the kit `FileRow` binds them regardless — so they print
 * regardless. `FileRow` already moves focus with ↑↓ and Home/End on its
 * own, so nothing here binds movement a second time.
 *
 * The evidence rail (sixth pass §3a): each block is independent and simply
 * absent when its data does not exist, but the COLUMN stays — "a pane count
 * that changes as you click through files is a worse defect than a sparse
 * rail." So the rail mounts with the panes, empty until a file is open, and
 * a file with no frontmatter shows only the blocks it has.
 */
function FilePanes({ onClose, panelRef }: { onClose: () => void; panelRef: RefObject<HTMLElement | null> }) {
  const currentPath = useFileStore((s) => s.currentPath);
  const content = useFileStore((s) => s.currentContent);
  const singleKeyShortcuts = useUIStore((s) => s.singleKeyShortcuts);
  const loaded = content !== null && content.path === currentPath ? content : null;

  const frontmatter: ReceiptRow[] =
    loaded?.kind === "markdown"
      ? splitFrontmatter(loaded.content ?? "").fields.map((f) => ({
          k: f.key,
          v: f.list ? f.list.join(", ") : f.value || "—",
        }))
      : [];

  // Stale (sixth pass §3b): `mtime` is on every file the server serves, in
  // milliseconds; the threshold is `STALE_AFTER_DAYS`. Past it the block
  // turns gold — the same tone the tree's dot wears.
  const modified = loaded ? ageInDays(loaded.mtime) : null;
  const stale = modified !== null && modified >= STALE_AFTER_DAYS;

  return (
    <section
      ref={panelRef}
      aria-label="Files"
      className="fixed bottom-0 right-0 top-0 z-panel flex bg-surface tablet:left-[60px] laptop:left-[208px]"
    >
      {/* Tree */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border">
        <div className="shrink-0 px-4 pb-2 pt-4">
          <h2 className="font-[family-name:var(--font-display)] text-[22px] leading-tight text-foreground" tabIndex={-1} data-destination-heading="">Files</h2>
        </div>
        {/* Untrusted only (sixth pass §3b): needs the provenance record —
            origin, who, when — which no file carries yet. Drawn, disabled,
            with its reason, never dropped: it is one of the two facts that
            decide whether an answer may cite a file. */}
        <div className="shrink-0 border-b border-border">
          <DisabledToggleRow label="Untrusted only" reason="needs provenance" tone="purple" last />
        </div>
        {/* `j` / `k` move between tree items while one holds focus (D36:
            focus-scoped, printed where they apply); the kit `FileRow` owns
            ↑↓, Home, End and the ← → fold. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onKeyDown={(e) => {
            if (!singleKeyShortcuts) return;
            const key = singleKey(e);
            if (key !== "j" && key !== "k") return;
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
            const here = items.indexOf(e.target as HTMLElement);
            if (here === -1) return;
            e.preventDefault();
            items[(here + (key === "j" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
        >
          <Suspense fallback={null}>
            <FileTree />
          </Suspense>
        </div>
        <div className="shrink-0 border-t border-border px-4 py-2 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">
          {singleKeyShortcuts ? "j / k move · " : ""}← → fold · ⏎ open
        </div>
      </aside>

      {/* Reading pane */}
      <section className="flex min-w-0 flex-1 flex-col" aria-label={currentPath ?? "No file open"}>
        <div className="flex shrink-0 items-start border-b border-border pr-3">
          <div className="min-w-0 flex-1">
            <ScreenHeader
              variant="nav"
              title={currentPath ?? "Files"}
              subtitle={loaded ? formatSize(loaded.size) : undefined}
              back={false}
              divider={false}
            />
          </div>
          <div className="shrink-0 pt-2">
            <Button label="Close" icon="dismiss" tone="ghost" size="sm" block={false} onClick={onClose} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto h-full w-full max-w-[720px]">
            <Suspense fallback={null}>
              <FileViewer />
            </Suspense>
          </div>
        </div>
      </section>

      {/* Evidence rail, from `wide:` only (the four-pane rule, D37 §2).
          Always in the tree once the panes are: the column never collapses. */}
      <aside
        aria-label="Evidence"
        className="hidden w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-background px-4 py-4 wide:flex"
      >
        {frontmatter.length > 0 && (
          <div className="flex flex-col gap-2" data-rail-block="frontmatter">
            <Label text="Frontmatter" icon="scope" meta={`${frontmatter.length} ${frontmatter.length === 1 ? "key" : "keys"}`} />
            <Receipt rows={frontmatter} keyWidth={72} />
          </div>
        )}
        {modified !== null && (
          <div className="flex flex-col gap-2" data-rail-block="modified" data-stale={stale ? "" : undefined}>
            <Label text="Modified" icon="history" tone={stale ? "gold" : undefined} meta={stale ? "stale" : undefined} />
            <div
              className={cn(
                "font-[family-name:var(--font-mono)] text-[10px]",
                stale ? "text-[var(--bk-gold-ink)]" : "text-muted-foreground"
              )}
            >
              modified {formatAge(modified)} · {stale ? "stale past" : "stale after"} {STALE_AFTER_DAYS}
            </div>
          </div>
        )}
        {/* The design also draws "Linked from" (backlinks) and "Provenance"
            (git hash, host, date) here. The app has no API for either yet,
            so neither is drawn: an evidence rail shows what is known. */}
      </aside>
    </section>
  );
}
