import { useStorageGuidance } from "../components/settings/storage/use-storage-guidance.js";
import { useBrainUiRoot, useRootStore } from "../root-context.js";
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
  const root = useBrainUiRoot();
  const [hash, setHash] = useState(() => window.location.hash);
  const syncingFromHash = useRef(false);
  const storage = useStorageGuidance(
    root,
    false,
    hash === "#/settings/storage"
  );
  const account = useRootStore("connection", (state) => state.accountKey);
  const openedStorage = useRef<{
    root: typeof root;
    epoch: number;
    account: string | null;
    hash: string;
  } | null>(null);
  const storageWasOpen = useRef(false);
  useEffect(() => {
    if (hash !== "#/settings/storage") {
      openedStorage.current = null;
      return;
    }
    if (
      !storage.guidance ||
      storage.error ||
      root.authLock.state.getState().phase !== "active"
    )
      return;
    const epoch = root.authLock.epoch();
    if (
      openedStorage.current?.root === root &&
      openedStorage.current.epoch === epoch &&
      openedStorage.current.account === account &&
      openedStorage.current.hash === hash
    )
      return;
    openedStorage.current = { root, epoch, account, hash };
    root.stores.ui.getState().openSettings("storage");
  }, [hash, storage.guidance, storage.error, root, account]);
  const storageOpen = useUIStore(
    (state) => state.settingsPanelOpen && state.settingsTab === "storage"
  );
  useEffect(() => {
    if (hash !== "#/settings/storage") {
      storageWasOpen.current = false;
      return;
    }
    if (storageOpen) {
      storageWasOpen.current = true;
      return;
    }
    if (
      !storageWasOpen.current ||
      root.authLock.state.getState().phase !== "active"
    )
      return;
    storageWasOpen.current = false;
    const view = root.stores.ui.getState().activeView;
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${
        view === "chat" ? "" : `#/${view}`
      }`
    );
    setHash(window.location.hash);
  }, [storageOpen, hash, root]);
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
    if (root.stores.ui.getState().activeView === view) return;
    syncingFromHash.current = true;
    setActiveView(view);
  }, [hash, setActiveView, root]);

  useEffect(() => {
    // A hash-driven store write and this effect are flushed together. Skip
    // the stale pre-write render so it cannot rewrite the incoming hash.
    if (syncingFromHash.current) {
      syncingFromHash.current = false;
      return;
    }

    // Preserve the authenticated Settings deep link while its authority read settles.
    if (window.location.hash === "#/settings/storage") return;
    if (activeView === "chat") {
      if (viewForHash(window.location.hash)) {
        history.replaceState(null, "", window.location.pathname);
      }
      return;
    }

    const config = VIEW_ROUTES.find(
      (candidate) => candidate.view === activeView
    )!;
    if (
      !matchesViewRoute(window.location.hash, config.view, config.prefixMatch)
    ) {
      history.replaceState(null, "", `#/${activeView}`);
    }
  }, [activeView]);
}
