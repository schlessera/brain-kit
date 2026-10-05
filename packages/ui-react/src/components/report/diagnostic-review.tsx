import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BottomSheet, Button } from "@schlessera/brain-ui-kit";

/** The public tracker every report goes to (D51). */
export const REPORT_ISSUE_URL = "https://github.com/schlessera/brain-kit/issues/new";
/** A prefilled issue link longer than this is refused, never truncated. */
export const REPORT_URL_LIMIT = 8000;

/** The exact link `Open issue on GitHub` opens: nothing is added at send time. */
export function reportIssueUrl(title: string, body: string): string {
  const url = new URL(REPORT_ISSUE_URL);
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  return url.href;
}

/**
 * Reviewed text appended at the end of the body on an explicit tap. `build`
 * returns null when the source is absent, and the button does not render.
 */
export interface ReviewInclusion {
  id: string;
  label: string;
  build: () => string | null;
  /** The status line after the block is appended. */
  notice?: string;
}

/** The copy that differs between the chat card and the Activity report. */
export interface ReviewCopy {
  reportSubtitle: string;
  copySubtitle: string;
  footnote: ReactNode;
  opened: string;
  openFailed: string;
  tooLong: string;
  copied: string;
  copyFailed: string;
}

export const CHAT_REVIEW_COPY: ReviewCopy = {
  reportSubtitle: "Opening the issue sends this text to GitHub before you submit the issue. Review and edit it first.",
  copySubtitle: "Review and edit this text. Copy places it on your clipboard only when you choose Copy.",
  footnote: "Provider text is omitted by default. Optional redaction is best effort; review for private content and credentials.",
  opened: "If the issue form did not open, copy the reviewed text and paste it into GitHub.",
  openFailed: "Couldn't open the issue form. Copy the reviewed text and paste it into GitHub.",
  tooLong: "This report is too long for the issue URL. Copy it and paste it into GitHub.",
  copied: "Copied reviewed details.",
  copyFailed: "Couldn't copy. Select the reviewed text and copy it manually.",
};

export interface DiagnosticReviewProps {
  mode: "copy" | "report";
  /**
   * The generated body. While the reader has not edited the field, a new
   * value replaces it (late facts, such as a fetched run record); once they
   * have, it never does, and `onLateBody` fires instead.
   */
  initialBody: string;
  onLateBody?: () => void;
  /** An editable title field; without one the issue title is `defaultIssueTitle`. */
  title?: { initial: string };
  defaultIssueTitle: string;
  inclusions?: ReviewInclusion[];
  copy?: ReviewCopy;
  /** Show the URL-length meter under the body. */
  meter?: boolean;
  /** A static note above the actions, such as the offline state. */
  note?: ReactNode;
  /** Shown once on a status line, for a late fact the reader must add by hand. */
  notice?: string;
  onClose: () => void;
  /** Where focus goes when the opener is no longer in the document. */
  returnFocus?: () => void;
  /** The heading text; defaults by mode. */
  heading?: string;
}

/** All outward bytes come from the editable fields after the reader reviews them. */
export function DiagnosticReview(p: DiagnosticReviewProps) {
  const copyText = p.copy ?? CHAT_REVIEW_COPY;
  const [body, setBody] = useState(p.initialBody);
  const [issueTitle, setIssueTitle] = useState(p.title?.initial ?? "");
  const [used, setUsed] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [opened, setOpened] = useState(false);
  const lastOpen = useRef(0);
  const generated = useRef(p.initialBody);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const titleId = useId();
  const returnFocus = useRef(p.returnFocus);
  returnFocus.current = p.returnFocus;
  const onLateBody = useRef(p.onLateBody);
  onLateBody.current = p.onLateBody;
  const headingText = p.heading ?? (p.mode === "report" ? "What will be sent" : "What will be copied");
  const finalTitle = p.title ? issueTitle : p.defaultIssueTitle;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialog.current!;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
    heading.current?.focus();
    return () => {
      node.close?.();
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else returnFocus.current?.();
    };
  }, []);

  // A late generated body replaces only an untouched field.
  // Both this and an inclusion update from the current value, so a fetch that
  // lands in the same frame as a tap can never drop what the tap appended.
  useEffect(() => {
    const previous = generated.current;
    if (p.initialBody === previous) return;
    generated.current = p.initialBody;
    if (bodyRef.current !== previous) onLateBody.current?.();
    setBody(current => (current === previous ? p.initialBody : current));
  }, [p.initialBody]);
  useEffect(() => { if (p.notice) setNotice(p.notice); }, [p.notice]);

  const url = reportIssueUrl(finalTitle, body);
  const tooLong = url.length > REPORT_URL_LIMIT;
  const outgoing = p.title ? `${issueTitle}\n\n${body}` : body;

  async function copy() {
    try { await navigator.clipboard.writeText(outgoing); setNotice(copyText.copied); }
    catch {
      const field = textarea.current;
      if (field) { field.focus(); field.select(); }
      setNotice(copyText.copyFailed);
    }
  }
  function report() {
    // A second tap inside a second is a double activation, not a second draft.
    const now = Date.now();
    if (now - lastOpen.current < 1000) return;
    // No implicit truncation: the exact fields are the payload. Large reports
    // can be copied and pasted instead of silently editing the reviewed text.
    if (tooLong) { setNotice(copyText.tooLong); return; }
    lastOpen.current = now;
    try { window.open(url, "_blank", "noopener,noreferrer"); setNotice(copyText.opened); setOpened(true); }
    catch { setNotice(copyText.openFailed); }
  }
  function include(inclusion: ReviewInclusion) {
    if (used.has(inclusion.id)) return;
    const block = inclusion.build();
    if (block === null) return;
    setBody(current => `${current}\n\n${block}`);
    setUsed(current => new Set(current).add(inclusion.id));
    if (inclusion.notice) setNotice(inclusion.notice);
    // Bring the appended block into view inside the field, not the page.
    requestAnimationFrame(() => {
      const field = textarea.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length - block.length, field.value.length);
      field.scrollTop = field.scrollHeight;
    });
  }
  const available = (p.inclusions ?? []).filter(i => i.build() !== null);

  return createPortal(
    <dialog ref={dialog} aria-label={headingText} className="turn-diagnostic-dialog" onCancel={e => { e.preventDefault(); p.onClose(); }}
      onClick={e => { if (e.target === e.currentTarget) p.onClose(); }}
      onKeyDown={e => {
        if (e.key !== "Tab") return;
        const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')]
          .filter(node => node.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (!first || !last) { e.preventDefault(); heading.current?.focus(); return; }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }}>
      <h2 ref={heading} tabIndex={-1} className="bk-sr-only">{headingText}</h2>
      <BottomSheet title={headingText} icon="scope" subtitle={p.mode === "report" ? copyText.reportSubtitle : copyText.copySubtitle}>
        {p.title ? (
          <>
            <label className="block text-xs text-muted-foreground" htmlFor={titleId}>Title</label>
            <input id={titleId} value={issueTitle} onChange={e => setIssueTitle(e.target.value)}
              className="mb-3 mt-2 w-full min-h-11 rounded-lg border border-border bg-surface-raised px-3 font-mono text-xs text-foreground" />
          </>
        ) : null}
        <label className="block text-xs text-muted-foreground" htmlFor={fieldId}>Exact outgoing text</label>
        <textarea ref={textarea} id={fieldId} value={body} onChange={e => setBody(e.target.value)}
          className={p.meter
            ? "mt-2 w-full min-h-72 max-h-[60vh] rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs text-foreground [overflow-wrap:anywhere] desktop:min-h-96"
            : "mt-2 w-full min-h-48 rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs text-foreground"} />
        {p.meter ? (
          <p data-report-meter="" className={tooLong ? "mt-1 font-mono text-xs text-destructive" : "mt-1 font-mono text-xs text-muted-foreground"}>
            {tooLong
              ? `Too long for the issue link by ${(url.length - REPORT_URL_LIMIT).toLocaleString("en-US")} — copy instead, or shorten it`
              : `${url.length.toLocaleString("en-US")} / ${REPORT_URL_LIMIT.toLocaleString("en-US")} characters in the URL`}
          </p>
        ) : null}
        <div className="my-3 text-xs text-muted-foreground">{copyText.footnote}</div>
        {p.note ? <p className="mb-3 text-xs text-muted-foreground">{p.note}</p> : null}
        <div className="flex flex-col gap-2">
          {available.map(i => (
            <Button key={i.id} label={i.label} disabled={used.has(i.id)} tone="ghost" onClick={() => include(i)} style={{ minHeight: 44 }} />
          ))}
          {p.mode === "report" ? <Button label={opened ? "Open issue on GitHub again" : "Open issue on GitHub"} effect="opens browser" onClick={report} style={{ minHeight: 44 }} /> : null}
          <Button label="Copy" onClick={() => void copy()} style={{ minHeight: 44 }} />
          <Button label="Close review" tone="ghost" onClick={p.onClose} style={{ minHeight: 44 }} />
        </div>
        {notice ? <p role="status" className="mt-3 text-xs text-muted-foreground">{notice}</p> : null}
      </BottomSheet>
    </dialog>, document.body,
  );
}
