import { useEffect, useRef, useState } from "react";
import { useFileStore } from "../stores/file-store.js";
import { useUIStore, type ActiveView } from "../stores/ui-store.js";

const VIEW_ROUTES: ReadonlyArray<{
  view: Exclude<ActiveView, "chat">;
  prefixMatch: boolean;
}> = [
  { view: "graph", prefixMatch: false },
  { view: "activity", prefixMatch: true },
];

function matchesViewRoute(
  hash: string,
  view: Exclude<ActiveView, "chat">,
  prefixMatch: boolean
): boolean {
  const route = `#/${view}`;
  return hash === route || (prefixMatch && hash.startsWith(`${route}/`));
}

function viewForHash(hash: string): Exclude<ActiveView, "chat"> | null {
  for (const { view, prefixMatch } of VIEW_ROUTES) {
    if (matchesViewRoute(hash, view, prefixMatch)) return view;
  }
  return null;
}

/**
 * Synchronize the shell's file and full-screen view routes with ui-react's
 * stores.
 */
export function useHashRoutes(): void {
  const [hash, setHash] = useState(() => window.location.hash);
  const syncingFromHash = useRef(false);
  const activeView = useUIStore((state) => state.activeView);
  const setActiveView = useUIStore((state) => state.setActiveView);
  const setFilePanelOpen = useUIStore((state) => state.setFilePanelOpen);
  const openFile = useFileStore((state) => state.openFile);
  const openDir = useFileStore((state) => state.openDir);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /**
   * Open the file panel + load a file when the URL hash points at
   * `#/files/<path>`. This only runs on hashchange (or initial mount); it does
   * not loop because the panel updates its hash with history.replaceState.
   */
  useEffect(() => {
    if (!hash.startsWith("#/files")) return;
    const raw = hash.slice("#/files".length).replace(/^\/+/, "");
    setFilePanelOpen(true);
    if (!raw) return;
    if (raw.endsWith("/")) {
      void openDir(raw.replace(/\/+$/, ""));
    } else {
      void openFile(raw);
    }
  }, [hash, setFilePanelOpen, openFile, openDir]);

  // The hash is the shareable entry point and the store is the source of
  // truth. Activity accepts a suffix so push links such as
  // `#/activity/<runId>` open the view without losing the deep link.
  useEffect(() => {
    const view = viewForHash(hash);
    if (!view) return;
    // Arm the suppression flag ONLY when this is a real view change. A hash
    // that keeps the same view — `#/activity/one` to `#/activity/two`, which
    // is every Activity deep link — makes setActiveView a no-op, so the effect
    // below never runs and never clears the flag. It would then swallow the
    // NEXT store-driven change, leaving the URL pointing at Activity while the
    // app shows Chat, and a refresh would jump back.
    if (useUIStore.getState().activeView === view) return;
    syncingFromHash.current = true;
    setActiveView(view);
  }, [hash, setActiveView]);

  useEffect(() => {
    // A hash-driven store write and this effect are flushed together. Skip
    // the stale pre-write render so it cannot rewrite the incoming hash.
    if (syncingFromHash.current) {
      syncingFromHash.current = false;
      return;
    }

    if (activeView === "chat") {
      if (viewForHash(window.location.hash)) {
        history.replaceState(null, "", window.location.pathname);
      }
      return;
    }

    const config = VIEW_ROUTES.find((candidate) => candidate.view === activeView)!;
    if (!matchesViewRoute(window.location.hash, config.view, config.prefixMatch)) {
      history.replaceState(null, "", `#/${activeView}`);
    }
  }, [activeView]);
}
