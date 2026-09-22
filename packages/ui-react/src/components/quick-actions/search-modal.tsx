import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Search, X, AlertTriangle } from "lucide-react";
import { SlidePanel } from "../layout/slide-panel.js";
import { Kbd } from "../layout/kbd.js";
import { useFileStore } from "../../stores/file-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import type { BrainSearchHit } from "../../lib/api-client.js";
import { useBrainApi } from "../../root-context.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { parseSnippet } from "../../lib/search-snippet.js";
import { cn } from "../../lib/utils.js";

/** Wait this long after the last keystroke before hitting the CLI. */
const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;
const LIMIT = 25;

type State = "idle" | "loading" | "done" | "error";

export function SearchPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const api = useBrainApi();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>("idle");
  const [resultQuery, setResultQuery] = useState("");
  const [results, setResults] = useState<BrainSearchHit[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);

  const trimmed = query.trim();
  const finePointer = useFinePointer();
  const currentResults = resultQuery === trimmed ? results : [];

  const cancelSearch = useCallback(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  function changeQuery(value: string) {
    if (value.trim() === trimmed) {
      setQuery(value);
      return;
    }
    // Invalidate before the debounce, including completions already queued.
    cancelSearch();
    setQuery(value);
    setResultQuery("");
    setResults([]);
    setWarnings([]);
    setError("");
    setSelected(0);
    setState("idle");
  }

  const runSearch = useCallback(async (q: string) => {
    cancelSearch();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState("loading");
    try {
      const res = await api.brainSearch(q, {
        limit: LIMIT,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResultQuery(q);
      setResults(res.results);
      setWarnings(res.warnings ?? []);
      setSelected(0);
      setState("done");
    } catch (err: any) {
      // A superseded request is not a failure — the newer one owns the state.
      if (err?.name === "AbortError" || controller.signal.aborted) return;
      setError(err?.message || "Search failed");
      setResults([]);
      setState("error");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [cancelSearch, api]);

  // Fresh panel every time it opens: stale results from a previous query would
  // otherwise flash before the first search lands.
  useEffect(() => {
    if (!open) {
      cancelSearch();
      return;
    }
    setQuery("");
    setResultQuery("");
    setResults([]);
    setWarnings([]);
    setError("");
    setState("idle");
    setSelected(0);
    // Focus after the slide-in starts; focusing mid-transform fights the
    // mobile keyboard on some browsers.
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => { clearTimeout(t); cancelSearch(); };
  }, [open, cancelSearch, api]);

  // Debounced search on typing.
  useEffect(() => {
    if (!open) return;
    if (trimmed.length < MIN_QUERY) {
      cancelSearch();
      setResults([]);
      setWarnings([]);
      setState("idle");
      return;
    }
    debounceRef.current = setTimeout(() => void runSearch(trimmed), DEBOUNCE_MS);
    return cancelSearch;
  }, [open, trimmed, runSearch, cancelSearch]);

  function handleOpenResult(hit: BrainSearchHit) {
    // The file panel takes the same right-hand slot, so hand the screen over
    // rather than stacking two sheets.
    if (resultQuery !== trimmed || state !== "done") return;
    cancelSearch();
    onClose();
    setFilePanelOpen(true);
    void openFile(hit.path);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (currentResults.length === 0) return;
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = (selected + delta + currentResults.length) % currentResults.length;
      setSelected(next);
      listRef.current
        ?.querySelectorAll("[data-result]")
        [next]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = currentResults[selected];
      if (hit) handleOpenResult(hit);
      // Enter with nothing selected jumps the debounce.
      else if (trimmed.length >= MIN_QUERY && state !== "loading") void runSearch(trimmed);
    }
  }

  return (
    <SlidePanel open={open} onClose={onClose} title="Search" wide>
      <div className="flex h-full flex-col">
        {/* Query field */}
        <div className="border-b border-border px-5 py-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2 focus-within:border-primary/40">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search your brain..."
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {state === "loading" && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            )}
            {query && state !== "loading" && (
              <button
                onClick={() => {
                  changeQuery("");
                  inputRef.current?.focus();
                }}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                title="Clear"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Degraded-mode notices from the CLI (e.g. FTS-only, no vectors) */}
        {warnings.length > 0 && (
          <div className="flex items-start gap-2 border-b border-border bg-surface-raised/40 px-5 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="text-[11px] leading-relaxed text-muted-foreground">
              {warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {state === "error" ? (
            <Placeholder>{error}</Placeholder>
          ) : trimmed.length < MIN_QUERY ? (
            <Placeholder>
              <span>
                Type at least {MIN_QUERY} characters.
                {/* The keys are printed only where one can be pressed (#86). */}
                {finePointer && (
                  <>
                    {" "}
                    <Kbd>↑</Kbd> <Kbd>↓</Kbd> to pick, <Kbd>↵</Kbd> to open.
                  </>
                )}
              </span>
            </Placeholder>
          ) : state === "done" && results.length === 0 ? (
            <Placeholder>No results for “{trimmed}”.</Placeholder>
          ) : (
            <div className="divide-y divide-border/40">
              {currentResults.map((hit, i) => (
                <ResultRow
                  key={hit.path}
                  hit={hit}
                  active={i === selected}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => handleOpenResult(hit)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <span className="text-[11px] text-muted-foreground">
            {state === "done" && results.length > 0
              ? `${results.length}${results.length === LIMIT ? "+" : ""} result${results.length === 1 ? "" : "s"}`
              : ""}
          </span>
          <button
            onClick={onClose}
            className="rounded-lg bg-surface-raised px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-overlay"
          >
            Close
          </button>
        </div>
      </div>
    </SlidePanel>
  );
}

function ResultRow({
  hit,
  active,
  onClick,
  onMouseEnter,
}: {
  hit: BrainSearchHit;
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <button
      data-result
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      title={hit.path}
      className={cn(
        "flex w-full flex-col gap-1 px-5 py-3 text-left transition-colors",
        active ? "bg-surface-raised" : "hover:bg-surface-raised/60"
      )}
    >
      <div className="flex items-baseline gap-2">
        {hit.type && (
          <span className="shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {hit.type}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {hit.title || hit.path}
        </span>
      </div>
      {hit.snippet && (
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {parseSnippet(hit.snippet).map((seg, i) =>
            seg.hit ? (
              <span key={i} className="text-foreground">
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </p>
      )}
      <span className="truncate font-mono text-[10px] text-muted-foreground/60">
        {hit.path}
      </span>
    </button>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-32 items-center justify-center px-8 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
