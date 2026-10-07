import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BottomSheet, Button } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { SAVING_SHOWN_AFTER_MS, draftSaveView } from "../../lib/drafts.js";
import type { DraftConflictChoice } from "../../stores/draft-state.js";

/**
 * The line under the composer while a draft exists (D52 §5): `draft ·
 * saved` only once the host acknowledged this exact revision, images
 * included; `draft · saving…` once a save has been out for 600ms; and the
 * honest states for a host that is unreachable, keeps no drafts, or
 * refused the size. A conflict prints `Compare`, which opens both versions.
 * Content is kept here in every state.
 */
export function DraftSaveLine({ draftId }: { draftId: string }) {
  const draft = useRootStore("drafts", (s) => s.drafts[draftId]);
  const supported = useRootStore("drafts", (s) => s.supported);
  const limits = useRootStore("drafts", (s) => s.limits);
  const [, tick] = useState(0);
  const [comparing, setComparing] = useState(false);
  const compareRef = useRef<HTMLButtonElement>(null);
  // `saving…` appears once the save has been out long enough, without another change to wait for.
  useEffect(() => {
    if (draft?.savingSince == null) return;
    const left = SAVING_SHOWN_AFTER_MS - (Date.now() - draft.savingSince);
    if (left <= 0) return;
    const timer = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [draft?.savingSince]);
  useEffect(() => { if (!draft?.conflict) setComparing(false); }, [draft?.conflict]);

  const view = draftSaveView(draft, { supported, limits }, Date.now());
  const tone = view.state === "saved" ? "text-accent"
    : view.state === "conflict" || view.state === "too_large" || view.state === "full" || view.state === "unsaved" ? "text-primary"
    : "text-muted-foreground";
  // Absent, with no spacer, while nothing needs saying.
  if (view.state === "none") return null;
  return (
    <div className="mx-auto mt-1 flex min-h-[16px] max-w-3xl items-center gap-2 px-1 font-mono text-[10.5px] leading-4" data-draft-save={view.state} data-draft-id={draftId}>
      {view.state === "conflict" ? (
        <>
          <span className={tone}>{view.copy}</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <button
            ref={compareRef}
            type="button"
            aria-haspopup="dialog"
            aria-label="Compare drafts"
            onClick={() => setComparing(true)}
            className="relative font-mono text-[10.5px] text-foreground underline underline-offset-2 before:absolute before:-inset-x-2 before:-inset-y-[14px] before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            data-draft-compare=""
          >
            Compare
          </button>
        </>
      ) : (
        <span className={tone}>{view.copy}</span>
      )}
      {comparing && draft?.conflict ? <CompareDrafts draftId={draftId} onClose={() => { setComparing(false); compareRef.current?.focus(); }} /> : null}
    </div>
  );
}

/** Each side's images, so two versions with the same count can still be told apart. */
function Thumbs({ urls, names }: { urls: string[]; names: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-compare-images="">
      {urls.map((url, i) => <img key={i} src={url} alt={names[i]} className="h-12 w-12 rounded-lg border border-border object-cover" />)}
    </div>
  );
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Compare drafts (D52 §5): this device's and the other device's version,
 * each with its edit time. Keep both turns the other version into an
 * unbound Draft entry. There is no automatic or model merge.
 */
export function CompareDrafts({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const root = useBrainUiRoot();
  const draft = useRootStore("drafts", (s) => s.drafts[draftId]);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
    heading.current?.focus();
    return () => { node.close?.(); };
  }, []);
  if (!draft?.conflict) return null;
  const other = draft.conflict.other;
  const choose = (choice: DraftConflictChoice) => {
    root.stores.drafts.getState().resolve(draftId, choice);
    onClose();
  };
  const images = (n: number) => (n > 0 ? ` · ${n} image${n === 1 ? "" : "s"}` : "");
  return createPortal(
    <dialog ref={dialog} aria-label="Compare drafts" className="turn-diagnostic-dialog" data-compare-drafts=""
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <h2 ref={heading} tabIndex={-1} className="bk-sr-only">Compare drafts</h2>
      <BottomSheet title="Compare drafts" icon="scope">
        <section className="mb-3" data-compare-side="this">
          <div className="font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">This device · edited {clock(draft.editedAt)}{images(draft.attachments.length)}</div>
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground">{draft.text || "(images only)"}</p>
          <Thumbs urls={draft.attachments.map((a) => a.previewUrl)} names={draft.attachments.map((a) => a.name)} />
        </section>
        <section className="mb-4" data-compare-side="other">
          <div className="font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">Other device · edited {clock(other.updatedAt)}{images(other.attachments.length)}</div>
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground">{other.text || "(images only)"}</p>
          <Thumbs urls={other.attachments.map((a) => `data:${a.mime};base64,${a.bytes}`)} names={other.attachments.map((a) => a.name ?? "image")} />
        </section>
        <div className="flex flex-wrap gap-2 pb-2">
          <Button label="Keep this device's" tone="primary" size="md" block={false} onClick={() => choose("mine")} />
          <Button label="Keep other's" tone="ghost" size="md" block={false} onClick={() => choose("other")} />
          <Button label="Keep both" tone="ghost" size="md" block={false} onClick={() => choose("both")} />
        </div>
      </BottomSheet>
    </dialog>,
    document.body,
  );
}
