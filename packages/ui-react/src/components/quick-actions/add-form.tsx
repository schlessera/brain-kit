import { Button, Callout } from "@schlessera/brain-ui-kit";
import { CheckCircle2 } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useId } from "react";
import { Kbd } from "../layout/kbd.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";

/**
 * The "Add to brain" form, rendered from props (S6). `AddPanel` is the
 * container: it owns the draft, the `brain add` / `brain index` requests and
 * the `operation.epoch` guard that keeps a stale save from landing in a
 * fresh form; this owns the two screens — the form, and the receipt after a
 * save — and nothing else.
 *
 * `state` is the container's machine: `editing` and `error` show the form
 * (with the error under it), `saving` is the form with the Add button inert,
 * `saved` is the receipt. On the receipt, `indexed` is three-valued because
 * an older server does not report it: `false` offers a retry, `true` says
 * so, `undefined` says the server did not say.
 *
 * Fields stay native (the kit has no text input); the buttons are the kit's.
 * The content field's ref is the container's, because focus after open and
 * after "Add another" is timed against the panel's slide, which the
 * container owns.
 */
export type AddState = "editing" | "saving" | "saved" | "error";

export interface AddDraft {
  content: string;
  title: string;
  type: string;
  tags: string;
}

export interface AddFormProps {
  state: AddState;
  draft: AddDraft;
  /** Types already in the brain, offered as completions — a hint list, not a closed set. */
  knownTypes: string[];
  error: string;
  savedPath: string;
  indexed: boolean | undefined;
  indexing: boolean;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  onDraft: (patch: Partial<AddDraft>) => void;
  onSave: () => void;
  onRetryIndex: () => void;
  onAddAnother: () => void;
  onClose: () => void;
}

export function AddForm(p: AddFormProps) {
  const typesId = useId();
  const saving = p.state === "saving";
  const canSave = p.draft.content.trim().length > 0 && !saving;
  const finePointer = useFinePointer();

  function onKeyDown(e: React.KeyboardEvent) {
    // Cmd/Ctrl+Enter saves from anywhere in the form. The container refuses
    // a save that is not from `editing` or `error`, so the receipt is safe.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      p.onSave();
    }
  }

  if (p.state === "saved") {
    return (
      <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <CheckCircle2 className="h-8 w-8 text-primary" />
          <p className="text-sm text-foreground">Added to your brain.</p>
          <p className="text-xs text-muted-foreground">
            {p.indexed === false
              ? "Saved, but not indexed. Your content is safe; search may not find it yet."
              : p.indexed === true
                ? "Saved and indexed. Run a sync when you want to push it."
                : "Saved. This server did not report whether indexing completed."}
          </p>
          {p.savedPath && <p className="break-all text-xs text-muted-foreground">{p.savedPath}</p>}
          {p.indexed === false && (
            <div className="flex flex-col items-center gap-2" role="status">
              {p.error && <p className="text-xs text-destructive">{p.error}</p>}
              <Button
                label={p.indexing ? "Indexing…" : "Retry indexing"}
                icon="retry"
                tone="primary"
                size="sm"
                block={false}
                disabled={p.indexing}
                onClick={p.onRetryIndex}
              />
            </div>
          )}
          <div className="flex gap-2">
            <Button label="Add another" icon="add" tone="ghost" size="sm" block={false} onClick={p.onAddAnother} />
            <Button label="Done" icon="confirm" tone="primary" size="sm" block={false} onClick={p.onClose} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <Field label="Note">
          <textarea
            ref={p.contentRef}
            value={p.draft.content}
            onChange={(e) => p.onDraft({ content: e.target.value })}
            rows={8}
            placeholder="What do you want to remember?"
            className="w-full resize-y rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
          />
        </Field>

        <Field label="Title" hint="optional, derived from the note if empty">
          <input
            value={p.draft.title}
            onChange={(e) => p.onDraft({ title: e.target.value })}
            className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" hint="optional">
            <input
              value={p.draft.type}
              onChange={(e) => p.onDraft({ type: e.target.value })}
              list={typesId}
              placeholder="note"
              className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
            />
            <datalist id={typesId}>
              {p.knownTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>

          <Field label="Tags" hint="comma-separated">
            <input
              value={p.draft.tags}
              onChange={(e) => p.onDraft({ tags: e.target.value })}
              placeholder="idea, reading"
              className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
            />
          </Field>
        </div>

        {p.state === "error" && (
          <div role="alert">
            <Callout tone="red" variant="banner" icon="failed" mono text={p.error} />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        {/* The hint is printed only where a key can be pressed (#86); the
            span stays so the buttons keep their side of the footer. */}
        <span className="text-[11px] text-muted-foreground">
          {finePointer && (
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd> + <Kbd>↵</Kbd> to save
            </>
          )}
        </span>
        <div className="flex gap-2">
          <Button label="Cancel" tone="quiet" size="sm" block={false} onClick={p.onClose} />
          <Button
            label={saving ? "Saving…" : "Add"}
            icon="add"
            tone="primary"
            size="sm"
            block={false}
            disabled={!canSave}
            onClick={p.onSave}
          />
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-foreground">
        {label}
        {hint && <span className="font-normal text-muted-foreground"> — {hint}</span>}
      </span>
      {children}
    </label>
  );
}
