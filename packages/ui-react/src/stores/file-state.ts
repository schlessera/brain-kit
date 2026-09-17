import { createStore } from "zustand/vanilla";
import type {
  FileEntry,
  FileContentResponse,
  FileResolveResponse,
  WikilinkMapResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import { FILE_SIZE_CAP_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import type { StoreEnvironment } from "./store-environment.js";
import { isMermaidPath } from "../lib/mermaid.js";

export interface FileState {
  // Tree state
  dirCache: Record<string, FileEntry[]>;
  loadingDirs: Set<string>;
  dirErrors: Record<string, string>;
  expandedDirs: Set<string>;

  // Viewer state
  currentPath: string | null;
  currentContent: FileContentResponse | null;
  contentLoading: boolean;
  contentError: string | null;
  viewMode: ViewMode;
  treeExpanded: boolean;
  /**
   * Whether the frontmatter table at the top of markdown files is collapsed.
   * Persisted in localStorage so the preference carries across files.
   */
  frontmatterCollapsed: boolean;
  /**
   * Directory most recently navigated to via openDir. Used by the tree to
   * apply a brief highlight + scroll the node into view. Cleared shortly
   * after by openDir itself.
   */
  highlightedDir: string | null;
  /**
   * Lowercase slug -> repo-relative .md path. Lazily loaded the first
   * time a markdown surface needs to resolve a [[wikilink]].
   */
  wikilinkMap: Record<string, string>;
  wikilinkLoaded: boolean;
  wikilinkLoading: boolean;

  // Actions
  loadDir: (path: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  setExpanded: (path: string, expanded: boolean) => void;
  openFile: (path: string) => Promise<void>;
  openDir: (path: string) => Promise<void>;
  closeFile: () => void;
  setViewMode: (mode: ViewMode) => void;
  setTreeExpanded: (expanded: boolean) => void;
  toggleFrontmatter: () => void;
  setHighlightedDir: (path: string | null) => void;
  ensureWikilinks: () => Promise<void>;
  reset: () => void;
}

export type ViewMode = "preview" | "raw";

/** Kinds/paths the viewer can render as a preview (vs raw text only). */
function hasPreview(content: FileContentResponse): boolean {
  return (
    content.kind === "markdown" ||
    content.kind === "html" ||
    (content.kind === "text" && isMermaidPath(content.path))
  );
}

export function createFileStore(env: StoreEnvironment) {
  const apiBase = env.apiBase;
  const fetch = env.request;
  const FRONTMATTER_COLLAPSED_KEY = env.storageKey("brain-ui:frontmatter-collapsed");

  function readFrontmatterCollapsed(): boolean {
    const storage = env.storage();
    if (!storage) return false;
    return env.storage()?.getItem(FRONTMATTER_COLLAPSED_KEY) === "1";
  }


  async function fetchTree(path: string): Promise<FileEntry[]> {
    const url = `${apiBase()}/files/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.entries;
  }

  async function fetchContent(path: string, signal: AbortSignal): Promise<FileContentResponse> {
    const res = await fetch(`${apiBase()}/files/content?path=${encodeURIComponent(path)}`, { signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      const err = new Error(body.error || `HTTP ${res.status}`);
      (err as Error & { status: number; size?: number }).status = res.status;
      if (body.size) (err as Error & { status: number; size?: number }).size = body.size;
      throw err;
    }
    return res.json();
  }

  async function fetchResolve(path: string, signal: AbortSignal): Promise<FileResolveResponse> {
    const res = await fetch(`${apiBase()}/files/resolve?path=${encodeURIComponent(path)}`, { signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function fetchWikilinks(): Promise<WikilinkMapResponse> {
    const res = await fetch(`${apiBase()}/files/wikilinks`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  let fileRequest: AbortController | null = null;
  let directoryRequest: AbortController | null = null;
  let cacheEpoch = 0;

  return createStore<FileState>((set, get) => ({
    dirCache: {},
    loadingDirs: new Set(),
    dirErrors: {},
    expandedDirs: new Set([""]),

    currentPath: null,
    currentContent: null,
    contentLoading: false,
    contentError: null,
    viewMode: "preview",
    treeExpanded: true,
    frontmatterCollapsed: readFrontmatterCollapsed(),
    highlightedDir: null,
    wikilinkMap: {},
    wikilinkLoaded: false,
    wikilinkLoading: false,

    loadDir: async (path) => {
      const epoch = cacheEpoch;
      const { dirCache, loadingDirs } = get();
      if (dirCache[path] || loadingDirs.has(path)) return;
      const next = new Set(loadingDirs);
      next.add(path);
      set({ loadingDirs: next });
      try {
        const entries = await fetchTree(path);
        if (epoch !== cacheEpoch) return;
        set((s) => {
          const loading = new Set(s.loadingDirs);
          loading.delete(path);
          const errors = { ...s.dirErrors };
          delete errors[path];
          return {
            dirCache: { ...s.dirCache, [path]: entries },
            loadingDirs: loading,
            dirErrors: errors,
          };
        });
      } catch (err) {
        if (epoch !== cacheEpoch) return;
        set((s) => {
          const loading = new Set(s.loadingDirs);
          loading.delete(path);
          return {
            loadingDirs: loading,
            dirErrors: { ...s.dirErrors, [path]: err instanceof Error ? err.message : "load_failed" },
          };
        });
      }
    },

    toggleDir: async (path) => {
      const { expandedDirs } = get();
      if (expandedDirs.has(path)) {
        const next = new Set(expandedDirs);
        next.delete(path);
        set({ expandedDirs: next });
      } else {
        const next = new Set(expandedDirs);
        next.add(path);
        set({ expandedDirs: next });
        await get().loadDir(path);
      }
    },

    setExpanded: (path, expanded) => {
      set((s) => {
        const next = new Set(s.expandedDirs);
        if (expanded) next.add(path);
        else next.delete(path);
        return { expandedDirs: next };
      });
    },

    openFile: async (path) => {
      fileRequest?.abort();
      directoryRequest?.abort();
      const request = new AbortController();
      fileRequest = request;
      const ownsRequest = () => fileRequest === request && !request.signal.aborted;
      const normalized = path.replace(/^\/+/, "").replace(/\\/g, "/");
      set({ currentPath: normalized, contentLoading: true, contentError: null, currentContent: null, treeExpanded: false });

      // Fire-and-await: load ancestor chain then content in parallel
      const ancestorsPromise = (async () => {
        try {
          const r = await fetchResolve(normalized, request.signal);
          if (!ownsRequest()) return;
          // Expand each ancestor and root, load their contents
          const dirsToLoad = ["", ...r.ancestors];
          set((s) => {
            const next = new Set(s.expandedDirs);
            for (const d of dirsToLoad) next.add(d);
            return { expandedDirs: next };
          });
          await Promise.all(dirsToLoad.map((d) => get().loadDir(d)));
        } catch {
          // Tree expansion best-effort
        }
      })();

      try {
        const content = await fetchContent(normalized, request.signal);
        // Drop a response the user has already navigated away from. Two rapid
        // clicks race, and without this the SLOWER fetch wins: the viewer showed
        // the newer file's path with the older file's content, which reads as
        // corruption rather than as a stale load.
        if (!ownsRequest()) return;
        set({ currentContent: content, contentLoading: false });
        // Default mode: prefer preview when available; persist otherwise
        const { viewMode } = get();
        if (!hasPreview(content) && viewMode === "preview") {
          set({ viewMode: "raw" });
        } else if (hasPreview(content) && viewMode === "raw") {
          // Keep raw if user toggled — but on a fresh open default back to preview
          set({ viewMode: "preview" });
        }
      } catch (err) {
        const e = err as Error & { status?: number; size?: number };
        let msg = e.message || "load_failed";
        if (e.status === 413 && e.size) msg = `File too large (${(e.size / 1024 / 1024).toFixed(2)} MB; cap ${(FILE_SIZE_CAP_BYTES / 1024 / 1024).toFixed(0)} MB).`;
        else if (e.status === 404) msg = "File not found.";
        else if (e.message === "invalid_path") msg = "Invalid path.";
        // Same guard: a failure for a file the user already left must not
        // replace the file they are now looking at with an error.
        if (!ownsRequest()) return;
        set({ contentError: msg, contentLoading: false });
      } finally {
        await ancestorsPromise;
      }
    },

    closeFile: () => {
      fileRequest?.abort();
      fileRequest = null;
      set({ currentPath: null, currentContent: null, contentError: null, contentLoading: false, treeExpanded: true });
    },

    openDir: async (path) => {
      directoryRequest?.abort();
      const request = new AbortController();
      directoryRequest = request;
      const normalized = path
        .replace(/^\/+/, "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "");
      if (!normalized) {
        // Just expand the root view
        set({ treeExpanded: true });
        return;
      }
      // Make the tree visible even if a file is currently open.
      set({ treeExpanded: true, highlightedDir: normalized });

      try {
        const r = await fetchResolve(normalized, request.signal);
        if (directoryRequest !== request || request.signal.aborted) return;
        const dirs = ["", ...r.ancestors, normalized];
        set((s) => {
          const next = new Set(s.expandedDirs);
          for (const d of dirs) next.add(d);
          return { expandedDirs: next };
        });
        await Promise.all(dirs.map((d) => get().loadDir(d)));
      } catch {
        // Best-effort expansion — failure surfaces via per-dir error state
      }
    },

    setViewMode: (mode) => set({ viewMode: mode }),

    setTreeExpanded: (expanded) => set({ treeExpanded: expanded }),

    setHighlightedDir: (path) => set({ highlightedDir: path }),

    ensureWikilinks: async () => {
      const epoch = cacheEpoch;
      const { wikilinkLoaded, wikilinkLoading } = get();
      if (wikilinkLoaded || wikilinkLoading) return;
      set({ wikilinkLoading: true });
      try {
        const data = await fetchWikilinks();
        if (epoch !== cacheEpoch) return;
        set({
          wikilinkMap: data.slugs,
          wikilinkLoaded: true,
          wikilinkLoading: false,
        });
      } catch {
        // Soft-fail — leave the map empty; wikilinks will render as plain text
        if (epoch !== cacheEpoch) return;
        set({ wikilinkLoading: false });
      }
    },

    toggleFrontmatter: () =>
      set((s) => {
        const next = !s.frontmatterCollapsed;
        if (env.storage() !== null) {
          if (next) env.storage()?.setItem(FRONTMATTER_COLLAPSED_KEY, "1");
          else env.storage()?.removeItem(FRONTMATTER_COLLAPSED_KEY);
        }
        return { frontmatterCollapsed: next };
      }),

    reset: () => {
      fileRequest?.abort();
      directoryRequest?.abort();
      fileRequest = null;
      directoryRequest = null;
      cacheEpoch++;
      set({
        dirCache: {}, loadingDirs: new Set(), dirErrors: {}, expandedDirs: new Set([""]),
        highlightedDir: null, wikilinkMap: {}, wikilinkLoaded: false, wikilinkLoading: false,
        currentPath: null,
        currentContent: null,
        contentLoading: false,
        contentError: null,
        viewMode: "preview",
        treeExpanded: true,
      });
    },
  }));

}

/**
 * Heuristics: is this string a plausible repo-relative path reference?
 *
 * Files require a trailing `.ext` (1-8 alphanumeric chars). Directories
 * require at least one `/` segment and a trailing `/`. Neither may look
 * like a URL, an absolute path, or a version number.
 */
const FILE_REF_RE = /^[a-z0-9_.-]+(\/[a-z0-9_.-]+)*\.[a-z0-9]{1,8}$/i;
const DIR_REF_RE = /^[a-z0-9_.-]+(\/[a-z0-9_.-]+)+\/$/i;
const URL_LIKE_RE = /^(?:https?:|mailto:|tel:|#|\/)/i;
const VERSION_RE = /^\d+(\.\d+){1,3}$/;

function rejectsCommonNonPath(href: string): boolean {
  if (URL_LIKE_RE.test(href)) return true;
  if (VERSION_RE.test(href)) return true;
  if (href.includes(" ")) return true;
  return false;
}

export function isInternalRepoPath(href: string | undefined): href is string {
  if (!href) return false;
  if (rejectsCommonNonPath(href)) return false;
  return FILE_REF_RE.test(href);
}

export function isInternalRepoDir(href: string | undefined): href is string {
  if (!href) return false;
  if (rejectsCommonNonPath(href)) return false;
  return DIR_REF_RE.test(href);
}

export type RepoPathKind = "file" | "dir";

export function classifyRepoPath(
  href: string | undefined
): RepoPathKind | null {
  if (isInternalRepoPath(href)) return "file";
  if (isInternalRepoDir(href)) return "dir";
  return null;
}

/** Normalize a directory ref by trimming the trailing slash. */
export function normalizeDirPath(path: string): string {
  return path.replace(/\/+$/, "");
}
