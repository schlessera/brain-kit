/**
 * The markup editor (#3983): the shared image-editor frame holding a
 * `MarkupCanvas`, a `MarkupToolbar` and a `MarkupNoteField`, with the
 * history, the confirmations and the size check that tie them together.
 *
 * Presentational in the kit's sense: the image URL, the source's displayed
 * size and the cap arrive as props; the encoded layer leaves through
 * `onSubmit` and a dismissal through `onDismiss`. It fetches nothing, writes
 * nothing and validates nothing against the source — that is the
 * integration's job (#3975), as is the server's own cap.
 *
 * - "Send markup" needs a committed mark. Otherwise it is disabled with the
 *   hint "Draw at least one mark.", and an empty layer is never exported.
 * - The PNG is encoded and its actual bytes measured. Up to `maxBytes`
 *   (52,428,800 by default) it is sent; above, the editor stays open and says
 *   how big it is.
 * - Dismissal (X, Escape, the overlay's close request) with marks first asks
 *   "Discard N marks?" — Keep drawing (focused first) / Discard. Declining exports nothing.
 * - Clear asks first when 3 or more marks would go; it is undoable either way.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Overlay } from "../chrome/Overlay.js";
import { Button } from "../primitives/Button.js";
import { color, font } from "../tokens.js";
import { ImageEditorFrame } from "./ImageEditorFrame.js";
import { MarkupCanvas, type MarkupView } from "./MarkupCanvas.js";
import { MarkupNoteField } from "./MarkupNoteField.js";
import { MARKUP_TOOLS, MarkupToolbar } from "./MarkupToolbar.js";
import {
  MARKUP_MAX_BYTES,
  exportMarkupPng,
  overCapMessage,
  type Mark,
  type MarkupColor,
  type MarkupExport,
  type MarkupPoint,
  type MarkupSize,
  type MarkupTool,
  type MarkupWidth,
  type TextMark,
} from "./markup.js";

export const MARKUP_EDITOR_TITLE = "Mark up the image";
/** The refusal text the integration returns when the user closes the editor. */
export const MARKUP_CLOSED = "The user closed the markup editor";

export interface MarkupEditorProps {
  open: boolean;
  /** The source image URL. */
  src: string;
  /** Repo-relative source path: the header shows it when there is no instruction. */
  imagePath: string;
  /** The agent's request, shown as plain text after "Agent asks:". */
  instruction?: string;
  /**
   * The source's displayed size after EXIF orientation, which the layer is
   * exported at. Omitted: the decoded image's size.
   */
  size?: MarkupSize;
  /** Defaults to `MARKUP_MAX_BYTES` (52,428,800). */
  maxBytes?: number;
  /**
   * The measured layer, within the cap. A rejection is shown in the editor's
   * error line and the editor stays open.
   */
  onSubmit: (layer: MarkupExport) => void | Promise<void>;
  /** Closed without sending: the integration returns `MARKUP_CLOSED`. */
  onDismiss: () => void;
  /** Stories and restored sessions. */
  initialMarks?: Mark[];
  initialView?: MarkupView;
  initialTool?: MarkupTool;
  /** Replaces the PNG encoder, for tests of the size boundary. */
  exportLayer?: (marks: readonly Mark[], size: MarkupSize) => Promise<MarkupExport>;
  /** Overrides the measured width's layout choice (stories). */
  layout?: "compact" | "wide";
}

interface History {
  past: Mark[][];
  present: Mark[];
  future: Mark[][];
}

interface NoteDraft {
  at: MarkupPoint;
  /** The placed note being edited, if any. */
  editing?: string;
  text: string;
}

let noteSequence = 0;
const noteId = () => `note-${Date.now().toString(36)}-${(noteSequence++).toString(36)}`;

const WIDE_EDITOR = 720;

export function MarkupEditor(p: MarkupEditorProps) {
  const [history, setHistory] = useState<History>({ past: [], present: p.initialMarks ?? [], future: [] });
  const [tool, setTool] = useState<MarkupTool>(p.initialTool ?? "pen");
  const [markColor, setMarkColor] = useState<MarkupColor>("red");
  const [markWidth, setMarkWidth] = useState<MarkupWidth>("medium");
  const [note, setNote] = useState<NoteDraft | null>(null);
  const [confirm, setConfirm] = useState<"discard" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [natural, setNatural] = useState<MarkupSize | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [frameWidth, setFrameWidth] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // The editor opens on the drawing stage, where the tool shortcuts work.
  const canvasFocus = useRef<HTMLElement | null>(null);
  // Bumped on dismissal and unmount: an export still encoding then belongs to
  // a drawing the user already discarded, and must never be sent.
  const session = useRef(0);
  useEffect(() => () => { session.current += 1; }, []);

  const marks = history.present;
  const size = p.size ?? natural;
  const layout = p.layout ?? (frameWidth >= WIDE_EDITOR ? "wide" : "compact");

  useEffect(() => {
    const here = stageRef.current;
    if (!here) return;
    const read = () => setFrameWidth(here.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(here);
    return () => observer.disconnect();
  }, [p.open]);

  const change = useCallback((next: Mark[]) => {
    setHistory(h => ({ past: [...h.past, h.present], present: next, future: [] }));
    setError(null);
  }, []);
  const undo = () => setHistory(h => h.past.length
    ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
    : h);
  const redo = () => setHistory(h => h.future.length
    ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
    : h);

  /** Commit the open note, if it has text: an edit replaces in place, a new note appends. */
  const settleNote = (draft: NoteDraft | null, list: Mark[]): Mark[] => {
    if (!draft) return list;
    const text = draft.text.trim();
    if (draft.editing) {
      const original = list.find(m => m.id === draft.editing);
      if (!text || (original?.kind === "text" && original.text === text)) return list;
      return list.map(m => (m.id === draft.editing && m.kind === "text" ? { ...m, text } : m));
    }
    if (!text) return list;
    const placed: TextMark = { id: noteId(), kind: "text", color: markColor, at: draft.at, text };
    return [...list, placed];
  };

  const placeNote = () => {
    const next = settleNote(note, marks);
    if (next !== marks) change(next);
    setNote(null);
  };
  const deleteNote = () => {
    if (note?.editing) change(marks.filter(m => m.id !== note.editing));
    setNote(null);
  };

  const onNoteRequest = (at: MarkupPoint, hit: TextMark | null) => {
    // A tap elsewhere while a note is open settles that note (an empty one is
    // dropped) rather than opening another.
    if (note) return placeNote();
    setNote(hit ? { at: hit.at, editing: hit.id, text: hit.text } : { at, text: "" });
  };

  const chooseTool = (next: MarkupTool) => {
    if (note) placeNote();
    setTool(next);
  };

  /** Clear asks first at 3 or more marks; an open note survives until it is confirmed. */
  const clear = () => {
    if (marks.length === 0) return;
    if (marks.length >= 3) return setConfirm("clear");
    setNote(null);
    change([]);
  };

  const requestClose = () => {
    if (confirm) return;
    const count = settleNote(note, marks).length;
    if (count === 0) {
      session.current += 1;
      return p.onDismiss();
    }
    setConfirm("discard");
  };

  const submit = async () => {
    const final = settleNote(note, marks);
    if (final !== marks) change(final);
    setNote(null);
    if (final.length === 0 || !size || submitting) return;
    const mine = session.current;
    setSubmitting(true);
    setError(null);
    try {
      const layer = await (p.exportLayer ?? exportMarkupPng)(final, size);
      if (session.current !== mine) return;
      const cap = p.maxBytes ?? MARKUP_MAX_BYTES;
      if (layer.bytes > cap) {
        setError(overCapMessage(layer.bytes, cap));
        return;
      }
      await p.onSubmit(layer);
    } catch (cause) {
      if (session.current === mine) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (session.current === mine) setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      return event.shiftKey ? redo() : undo();
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      return redo();
    }
    if (mod || event.altKey) return;
    const shortcut = MARKUP_TOOLS.find(t => t.key.toLowerCase() === event.key.toLowerCase());
    if (shortcut) {
      event.preventDefault();
      chooseTool(shortcut.tool);
    }
  };

  const committed = settleNote(note, marks).length;
  const count = (n: number) => `${n} ${n === 1 ? "mark" : "marks"}`;

  const noteField = useMemo(() => note ? {
    at: note.at,
    editing: note.editing,
    node: (
      <MarkupNoteField
        value={note.text}
        onChange={text => setNote(n => (n ? { ...n, text } : n))}
        onPlace={placeNote}
        onCancel={() => setNote(null)}
        onDelete={note.editing ? deleteNote : undefined}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  } : undefined, [note, marks, markColor]);

  const confirmation = confirm ? (
    <Overlay
      open
      variant="dialog"
      role="alertdialog"
      theme="dark"
      title={confirm === "discard" ? `Discard ${count(committed)}?` : `Clear ${count(marks.length)}?`}
      onClose={() => setConfirm(null)}
      data-markup-confirm={confirm}
    >
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
        {/* The safe choice comes first, so it takes the opening focus: Enter keeps the drawing. */}
        <Button label="Keep drawing" tone="ghost" block={false} onClick={() => setConfirm(null)} style={{ minHeight: 44 }} />
        <Button
          label={confirm === "discard" ? "Discard" : "Clear"}
          tone="danger"
          block={false}
          onClick={() => {
            setConfirm(null);
            if (confirm === "discard") {
              session.current += 1;
              setNote(null);
              p.onDismiss();
            } else {
              setNote(null);
              change([]);
            }
          }}
          style={{ minHeight: 44 }}
        />
      </div>
    </Overlay>
  ) : null;

  // The confirmation is a sibling modal, not a child: nested inside the
  // fullscreen surface it would inherit that surface's full-bleed layout.
  return (
    <>
    <ImageEditorFrame
      open={p.open}
      title={MARKUP_EDITOR_TITLE}
      subtitle={p.instruction ?? p.imagePath}
      subtitlePrefix={p.instruction ? "Agent asks:" : undefined}
      subtitleMode="expand"
      closeLabel="Close"
      onClose={requestClose}
      error={loadError ? `Could not load ${p.imagePath}` : error}
      stageRef={stageRef}
      initialFocus={canvasFocus}
      stagePadding={0}
      data-markup-editor=""
      toolbar={
        <MarkupToolbar
          layout={layout}
          tool={tool}
          onTool={chooseTool}
          color={markColor}
          onColor={next => {
            setMarkColor(next);
            // A note being edited takes the chosen colour.
            if (note?.editing) change(marks.map(m => (m.id === note.editing ? { ...m, color: next } : m)));
          }}
          width={markWidth}
          onWidth={setMarkWidth}
          canUndo={history.past.length > 0}
          canRedo={history.future.length > 0}
          canClear={marks.length > 0}
          onUndo={() => { setNote(null); undo(); }}
          onRedo={() => { setNote(null); redo(); }}
          onClear={clear}
          canSubmit={committed > 0 && !!size && !loadError}
          submitting={submitting}
          onSubmit={() => void submit()}
        />
      }
    >
      <MarkupCanvas
        src={p.src}
        size={p.size}
        marks={marks}
        tool={tool}
        color={markColor}
        width={markWidth}
        onCommit={mark => change([...marks, mark])}
        onNoteRequest={onNoteRequest}
        noteField={noteField}
        onLoad={measured => { setNatural(measured); setLoadError(false); }}
        onError={() => setLoadError(true)}
        onKeyDown={onKeyDown}
        initialView={p.initialView}
        focusTarget={canvasFocus}
      />
      {submitting ? (
        <div aria-live="polite" style={{ position: "absolute", left: 12, bottom: 12, font: `500 12px/16px ${font.mono}`, color: color.inkMute }}>
          Preparing markup…
        </div>
      ) : null}
    </ImageEditorFrame>
    {confirmation}
    </>
  );
}
