import { useState, useEffect, useRef } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { SlidePanel } from "../layout/slide-panel.js";
import { Kbd } from "../layout/kbd.js";
import { api } from "../../lib/api-client.js";

type State = "editing" | "saving" | "saved" | "error";

/** Split the tags field on commas; empties dropped so "a,,b," is clean. */
function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function AddPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("");
  const [tags, setTags] = useState("");
  const [state, setState] = useState<State>("editing");
  const [error, setError] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [indexed, setIndexed] = useState<boolean | undefined>();
  const [indexing, setIndexing] = useState(false);
  const operation = useRef({ epoch: 0 }).current;
  // Types already in the brain, offered as completions — `brain add` accepts
  // any string, so this is a hint list, not a closed set.
  const [knownTypes, setKnownTypes] = useState<string[]>([]);

  const contentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    operation.epoch++;
    setSavedPath("");
    setIndexed(undefined);
    setIndexing(false);
    setContent("");
    setTitle("");
    setType("");
    setTags("");
    setError("");
    setState("editing");

    const t = setTimeout(() => contentRef.current?.focus(), 120);

    let cancelled = false;
    api
      .brainStats()
      .then((s) => {
        if (!cancelled) setKnownTypes(Object.keys(s.byType).sort());
      })
      .catch(() => {
        // Completions are a nicety; a failed stats call must not block adding.
      });

    return () => {
      operation.epoch++;
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, operation]);

  async function handleSave() {
    const body = content.trim();
    if (!body || (state !== "editing" && state !== "error")) return;
    const current = ++operation.epoch;

    setState("saving");
    setError("");
    try {
      const result = await api.brainAdd(body, {
        type: type.trim() || undefined,
        title: title.trim() || undefined,
        tags: parseTags(tags).length ? parseTags(tags) : undefined,
      });
      if (current !== operation.epoch) return;
      setSavedPath(result.path ?? "");
      setIndexed(result.indexed);
      setError(result.indexed === false ? result.indexError || "Indexing failed." : "");
      setState("saved");
    } catch (err: any) {
      if (current !== operation.epoch) return;
      setError(err?.message || "Add failed");
      setState("error");
    }
  }

  async function retryIndex() {
    if (indexing) return;
    const current = ++operation.epoch;
    setIndexing(true);
    setError("");
    try {
      await api.brainIndex();
      if (current === operation.epoch) setIndexed(true);
    } catch (err) {
      if (current === operation.epoch) setError(err instanceof Error ? err.message : "Indexing failed.");
    } finally {
      if (current === operation.epoch) setIndexing(false);
    }
  }

  function handleAddAnother() {
    operation.epoch++;
    setSavedPath("");
    setIndexed(undefined);
    setIndexing(false);
    setContent("");
    setTitle("");
    setType("");
    setTags("");
    setState("editing");
    setTimeout(() => contentRef.current?.focus(), 0);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Cmd/Ctrl+Enter saves from anywhere in the form.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSave();
    }
  }

  const saving = state === "saving";
  const canSave = content.trim().length > 0 && !saving;

  return (
    <SlidePanel open={open} onClose={onClose} title="Add to brain" wide>
      <div className="flex h-full flex-col" onKeyDown={handleKeyDown}>
        {state === "saved" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
            <CheckCircle2 className="h-8 w-8 text-primary" />
            <p className="text-sm text-foreground">Added to your brain.</p>
            <p className="text-xs text-muted-foreground">
              {indexed === false ? "Saved, but not indexed. Your content is safe; search may not find it yet."
                : indexed === true ? "Saved and indexed. Run a sync when you want to push it."
                : "Saved. This server did not report whether indexing completed."}
            </p>
            {savedPath && <p className="break-all text-xs text-muted-foreground">{savedPath}</p>}
            {indexed === false && (
              <div className="space-y-2" role="status">
                {error && <p className="text-xs text-destructive">{error}</p>}
                <button onClick={retryIndex} disabled={indexing} className="rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground disabled:opacity-40">
                  {indexing ? "Indexing..." : "Retry indexing"}
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleAddAnother}
                className="rounded-lg bg-surface-raised px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-overlay"
              >
                Add another
              </button>
              <button
                onClick={onClose}
                className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <Field label="Note">
                <textarea
                  ref={contentRef}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={8}
                  placeholder="What do you want to remember?"
                  className="w-full resize-y rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
                />
              </Field>

              <Field label="Title" hint="optional, derived from the note if empty">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Type" hint="optional">
                  <input
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    list="brain-add-types"
                    placeholder="note"
                    className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
                  />
                  <datalist id="brain-add-types">
                    {knownTypes.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </Field>

                <Field label="Tags" hint="comma-separated">
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="idea, reading"
                    className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
                  />
                </Field>
              </div>

              {state === "error" && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  <span className="text-xs text-destructive">{error}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-border px-5 py-3">
              <span className="text-[11px] text-muted-foreground">
                <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd> + <Kbd>↵</Kbd> to save
              </span>
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="rounded-lg bg-surface-raised px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-overlay"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={!canSave}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {saving ? "Saving..." : "Add"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </SlidePanel>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-foreground">
        {label}
        {hint && (
          <span className="font-normal text-muted-foreground"> — {hint}</span>
        )}
      </span>
      {children}
    </label>
  );
}
