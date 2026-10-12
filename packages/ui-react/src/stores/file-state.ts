import { createStore } from "zustand/vanilla";
import type {
  FileEntry,
  FileContentResponse,
  FileResolveResponse,
  WikilinkMapResponse,
} from "@schlessera/brain-ui-sdk/protocol";
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
  /** A typed observation, never an inference from server error copy. */
  contentFailure: FileLoadFailure | null;
  /**
   * The open file is a scratch file that is gone (#1657). The viewer shows it
   * as expired rather than as an error.
   */
  contentExpired: boolean;
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
  /**
   * What a scratch link's target was found to be (#1657), keyed by
   * `scratchPath`. Absent means unchecked, or a check that failed for a
   * reason other than not-found; both keep the ordinary link.
   */
  scratchFiles: Record<string, "present" | "expired">;

  // Actions
  loadDir: (path: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  setExpanded: (path: string, expanded: boolean) => void;
  openFile: (path: string) => Promise<void>;
  /** Repeat only a temporary failed load; never start concurrent attempts. */
  retryFile: () => Promise<void>;
  /** Confirm a secondary preview failure through the existing authenticated HEAD route. */
  checkPreview: (content: FileContentResponse, html?: boolean) => Promise<boolean>;
  openDir: (path: string) => Promise<void>;
  closeFile: () => void;
  setViewMode: (mode: ViewMode) => void;
  setTreeExpanded: (expanded: boolean) => void;
  toggleFrontmatter: () => void;
  setHighlightedDir: (path: string | null) => void;
  ensureWikilinks: () => Promise<void>;
  /** Ask the server once whether a scratch file still exists (#1657). */
  checkScratchFile: (path: string, options?: { revalidate?: boolean }) => Promise<void>;
  reset: () => void;
}

export type ViewMode = "preview" | "raw";

export interface FileLoadFailure {
  kind: "unreachable" | "unauthenticated" | "forbidden" | "not-found" | "too-large" | "unknown";
  size?: number;
}

function observedFailure(error: unknown): FileLoadFailure {
  const e = error as { status?: number; size?: number; name?: string } | null;
  if (e?.status === 401) return { kind: "unauthenticated" };
  if (e?.status === 403) return { kind: "forbidden" };
  if (e?.status === 404) return { kind: "not-found" };
  if (e?.status === 413) return { kind: "too-large", ...(typeof e.size === "number" && Number.isFinite(e.size) && e.size >= 0 ? { size: e.size } : {}) };
  if (e?.status === undefined && (error instanceof TypeError || e?.name === "TimeoutError")) return { kind: "unreachable" };
  return { kind: "unknown" };
}

const FAILURE_COPY: Record<FileLoadFailure["kind"], string> = {
  unreachable: "Can't reach your brain right now.",
  unauthenticated: "Sign in to open this file.",
  forbidden: "This file isn't available with your current access.",
  "not-found": "File not found.",
  "too-large": "Too large to preview here.",
  unknown: "Couldn't open this file.",
};

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
      if (typeof body.size === "number" && Number.isFinite(body.size) && body.size >= 0) (err as Error & { status: number; size?: number }).size = body.size;
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

  /** HEAD on the raw route: the bytes stay on the server, the status says enough. */
  async function scratchFileStatus(path: string): Promise<"present" | "expired" | null> {
    const res = await fetch(`${apiBase()}/files/content?path=${encodeURIComponent(path)}&raw=1`, { method: "HEAD" });
    if (res.status === 404) return "expired";
    // A file over the size cap still exists.
    if (res.ok || res.status === 413) return "present";
    return null;
  }

  const scratchChecks = new Map<string, Promise<void>>();
  /** Per scratch file, which piece of evidence is the latest. */
  const scratchTurns = new Map<string, number>();
  const nextScratchTurn = (key: string) => {
    const turn = (scratchTurns.get(key) ?? 0) + 1;
    scratchTurns.set(key, turn);
    return turn;
  };
  let fileRequest: AbortController | null = null;
  let directoryRequest: AbortController | null = null;
  let cacheEpoch = 0;
  let previewChecks = new WeakMap<FileContentResponse, Promise<boolean>>();

  function failureUpdate(path: string, error: unknown, state: FileState): Partial<FileState> {
    const failure = observedFailure(error);
    const scratch = failure.kind === "not-found" ? scratchPath(path) : null;
    if (scratch) {
      nextScratchTurn(scratch);
      return { currentContent: null, contentError: null, contentFailure: null, contentExpired: true, contentLoading: false,
        scratchFiles: { ...state.scratchFiles, [scratch]: "expired" } };
    }
    return { currentContent: null, contentFailure: failure, contentError: FAILURE_COPY[failure.kind], contentExpired: false, contentLoading: false };
  }

  return createStore<FileState>((set, get) => ({
    dirCache: {},
    loadingDirs: new Set(),
    dirErrors: {},
    expandedDirs: new Set([""]),

    currentPath: null,
    currentContent: null,
    contentLoading: false,
    contentError: null,
    contentFailure: null,
    contentExpired: false,
    viewMode: "preview",
    treeExpanded: true,
    frontmatterCollapsed: readFrontmatterCollapsed(),
    highlightedDir: null,
    wikilinkMap: {},
    wikilinkLoaded: false,
    wikilinkLoading: false,
    scratchFiles: {},

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
      set({ currentPath: normalized, contentLoading: true, contentError: null, contentFailure: null, contentExpired: false, currentContent: null, treeExpanded: false });

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
        // Same guard: a failure for a file the user already left must not
        // replace the file they are now looking at with an error.
        if (!ownsRequest()) return;
        set(failureUpdate(normalized, err, get()));
      } finally {
        await ancestorsPromise;
      }
    },

    retryFile: async () => {
      const state = get();
      if (!state.currentPath || state.contentLoading || !["unreachable", "unknown"].includes(state.contentFailure?.kind ?? "")) return;
      await state.openFile(state.currentPath);
    },

    checkPreview: (content, html = false) => {
      const owner = fileRequest;
      const ownsPreview = () => owner !== null && fileRequest === owner && !owner.signal.aborted && get().currentContent === content;
      if (!ownsPreview()) return Promise.resolve(false);
      const pending = previewChecks.get(content);
      if (pending) return pending;
      const check = (async () => {
        try {
          const url = html ? `${apiBase()}/files/html?path=${encodeURIComponent(content.path)}` : `${apiBase()}/files/content?path=${encodeURIComponent(content.path)}&raw=1`;
          const response = await fetch(url, { method: "HEAD", signal: owner!.signal });
          if (!ownsPreview()) return false;
          if (response.ok) return true;
          set(failureUpdate(content.path, { status: response.status, size: content.size }, get()));
        } catch (error) {
          if (ownsPreview()) set(failureUpdate(content.path, error, get()));
        }
        return false;
      })().finally(() => { previewChecks.delete(content); });
      previewChecks.set(content, check);
      return check;
    },

    closeFile: () => {
      fileRequest?.abort();
      fileRequest = null;
      set({ currentPath: null, currentContent: null, contentError: null, contentFailure: null, contentExpired: false, contentLoading: false, treeExpanded: true });
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

    checkScratchFile: (path, options) => {
      const key = scratchPath(path);
      if (!key) return Promise.resolve();
      // Expired is final. Present is final too, unless the caller has just
      // seen the file fail to load and asks again.
      const known = get().scratchFiles[key];
      if (known === "expired" || (known === "present" && !options?.revalidate)) return Promise.resolve();
      const pending = scratchChecks.get(key);
      if (pending) return pending;
      const epoch = cacheEpoch;
      const turn = nextScratchTurn(key);
      const check = scratchFileStatus(key)
        .then((status) => {
          // A newer answer for this file (a later check, or a 404 from
          // opening it) wins over this one.
          if (status && epoch === cacheEpoch && scratchTurns.get(key) === turn) {
            set((s) => ({ scratchFiles: { ...s.scratchFiles, [key]: status } }));
          }
        })
        // Offline, signed out or a server fault: not evidence that the file
        // is gone, so the link stays as it is and a later render asks again.
        .catch(() => {})
        .finally(() => {
          if (scratchChecks.get(key) === check) scratchChecks.delete(key);
        });
      scratchChecks.set(key, check);
      return check;
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
      scratchChecks.clear();
      scratchTurns.clear();
      previewChecks = new WeakMap();
      set({
        dirCache: {}, loadingDirs: new Set(), dirErrors: {}, expandedDirs: new Set([""]),
        highlightedDir: null, wikilinkMap: {}, wikilinkLoaded: false, wikilinkLoading: false,
        currentPath: null,
        currentContent: null,
        contentLoading: false,
        contentError: null,
        contentFailure: null,
        contentExpired: false,
        scratchFiles: {},
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

/**
 * The persistent scratch area (#1657). A file there is kept for a while and
 * then pruned, so a link to one can outlive it.
 */
const SCRATCH_PREFIX = ".brain/scratch/";

/**
 * The repo-relative path of a scratch file reference, normalized, or null
 * when the reference is not a file inside the scratch area.
 */
export function scratchPath(href: string | undefined): string | null {
  if (!href) return null;
  const rel = href.trim().replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (!rel.startsWith(SCRATCH_PREFIX) || rel.length === SCRATCH_PREFIX.length) return null;
  if (rel.endsWith("/") || rel.split("/").some((segment) => segment === ".." || segment === ".")) return null;
  return rel;
}

/** Normalize a directory ref by trimming the trailing slash. */
export function normalizeDirPath(path: string): string {
  return path.replace(/\/+$/, "");
}
