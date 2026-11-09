import { Overlay, Button, IconButton, Callout, Composer as KitComposer, ModelPicker, ListRow, type ComposerState, type ModelPickerProps } from "@schlessera/brain-ui-kit";
import { TrackChip } from "./track-chip.js";
import { FileChip } from "./file-chip.js";
import type { PendingTrack } from "../../lib/track-uploads.js";
import type { QueuedFile } from "../../lib/attachment-queue.js";
import type { AttachmentFile } from "@schlessera/brain-ui-sdk/protocol";
import { X } from "lucide-react";
import { useId } from "react";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { isThinkingLevel, type ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";

/**
 * The composer's frame, rendered from props (S7, the `chat` directory).
 * `Composer` is the container: it owns the draft, the attachments and their
 * object URLs, the provider choice, the voice review, the command palette's
 * open state and every store read.
 *
 * The field itself is the kit `Composer` (D37: the composer is kit-owned —
 * it is the one piece of permanent chrome, and a field redrawn per screen is
 * a component nobody can audit). The kit draws attach · field · mic ·
 * send/stop, the provider chip in the hint line and the state-driven
 * placeholder, hint and trailing control. What this frame adds around it is
 * what the design leaves to the app: the slash-command palette above the
 * field, the attachment previews and their errors, the attach MENU behind
 * the paperclip (a docked `BottomSheet` on a phone, a popover on a pointer
 * screen — capture is a menu, not three more icons), the provider list, and
 * two keys the kit does not know: ↑ on an empty draft recalls the last
 * prompt, and esc dismisses the slash palette.
 *
 * Paste-to-attach is caught here too: the kit's textarea has no paste
 * handler of its own, and the event bubbles to this frame with its files.
 */
interface ComposerAttachment {
  previewUrl: string;
  name: string;
}

/**
 * A stored original in the composer (#3155). `image` is set for an image
 * original: whether its frame goes inline with the message (design §8.4), and
 * the frame's thumbnail once it is made.
 */
interface ComposerStoredFile {
  file: AttachmentFile;
  detached: boolean;
  image?: { placement: "inline" | "not_inline" | "pending"; previewUrl?: string };
}

interface ComposerProvider {
  label: string;
  /** The model is fixed for this conversation; effort remains editable. */
  locked: boolean;
  menuOpen: boolean;
  options: { id: string; label: string }[];
  selectedId: string | null;
  defaultEffort?: ThinkingLevel;
  effortLevels?: ThinkingLevel[];
  selectedEffort?: ThinkingLevel;
  effortExplanation?: string;
  /** Under a locked model: continue on another backend (#61). */
  lockedAction?: { label: string; detail?: string; why?: string; onSelect: () => void };
}

export interface ComposerViewProps {
  /** Capture panel, kept inside the existing bounded composer frame. */
  dictation?: ReactNode;
  onConversation?: () => void;
  /**
   * Why the mic cannot record, in place of the capture panel: a refused
   * microphone, or a browser that cannot record on the device (#1012).
   */
  captureNotice?: string;
  dictationNotice?: string;
  onDismissDictationNotice?: () => void;
  onDismissCaptureNotice?: () => void;
  /** The mic's accessible name when it does not dictate, or names the dictation service. */
  micLabel?: string;
  /** Shows micLabel as the mic's pointer tooltip. */
  micTip?: boolean;
  /** Why the mic cannot be used: it is drawn disabled with this explanation. */
  micUnavailable?: string;
  /** Off: no mic is drawn, because there is no capture to offer. */
  mic?: boolean;
  value: string;
  state: ComposerState;
  /** Overrides the state's own placeholder (a connection reason, the host's copy). */
  placeholder?: string;
  /** Overrides the state's own hint ("Will queue" while a session runs). */
  hint?: string;
  /** The offline reason, printed in the hint row. */
  blockedWhy?: string;
  paletteOpen: boolean;
  /** The command palette, already rendered by the container, or null. */
  palette: ReactNode;
  attachMenuOpen: boolean;
  attachments: ComposerAttachment[];
  tracks?: PendingTrack[];
  onRemoveTrack?: (id: string) => void;
  onRetryTrack?: (id: string) => void;
  /**
   * The draft's composer files (#3155): uploads still queued, then the
   * originals the host stored. `detached` marks one this draft's id cannot
   * bind. Shown only with `onPickFiles`.
   */
  files?: { queued: readonly QueuedFile[]; stored: readonly ComposerStoredFile[] };
  onRemoveQueuedFile?: (id: string) => void;
  onRetryQueuedFile?: (id: string) => void;
  onRemoveStoredFile?: (fileId: string) => void;
  /** Polite, once: a file's upload reached an end state (stored, failed, refused). */
  fileAnnouncement?: string;
  /**
   * The draft's compact status beside Attach (additive, #3155): the draft
   * indicator, or its reserved empty slot. Absent: no slot is drawn.
   */
  status?: ReactNode;
  /**
   * Files that were still uploading when the page closed (#3155, rev 5
   * §1): a dismissible notice that names them. It claims nothing about what
   * the host stored or will remove.
   */
  uploadNotice?: string;
  onDismissUploadNotice?: () => void;
  attachErrors: string[];
  provider: ComposerProvider | null;
  chatProfile?: ModelPickerProps["chat"];
  /** The container's ref: it focuses the field after a recall or a voice edit. */
  frameRef: RefObject<HTMLDivElement | null>;
  /** The container's ref for the provider popover's outside-click dismissal. */
  providerMenuRef: RefObject<HTMLDivElement | null>;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Omitted while the mic has nothing to do yet. */
  onMic?: () => void;
  onAttachToggle: () => void;
  onPickLibrary: () => void;
  onPickCamera: () => void;
  onPickTracks?: () => void;
  /**
   * The unrestricted Files source (additive; #3155). Present when the host
   * keeps composer originals: the menu then offers Files instead of Track
   * files, desktop drops Photo library and Camera, and dropped files feed
   * the same pipeline as pasted ones. `onPickTracks` stays supported.
   */
  onPickFiles?: () => void;
  onPasteFiles: (files: File[]) => void;
  onRecall: () => void;
  onEscape: () => void;
  /** Moves the slash palette's active row; absent while it shows none. */
  onPaletteMove?: (step: 1 | -1) => void;
  onRemoveAttachment: (index: number) => void;
  onDismissErrors: () => void;
  onProviderToggle: () => void;
  onProviderSelect: (id: string) => void;
  onProviderDismiss: () => void;
  onEffortSelect: (level: ThinkingLevel | null) => void;
}

export function ComposerView(p: ComposerViewProps) {
  const pickerId = useId();
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).tagName !== "TEXTAREA") return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && p.paletteOpen && p.onPaletteMove) {
      e.preventDefault();
      p.onPaletteMove(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "ArrowUp" && !p.value.trim()) p.onRecall();
    if (e.key === "Escape" && p.paletteOpen) p.onEscape();
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    p.onPasteFiles(Array.from(files));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    const files = e.dataTransfer?.files;
    if (!p.onPickFiles || !files || files.length === 0) return;
    e.preventDefault();
    p.onPasteFiles(Array.from(files));
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (p.onPickFiles && e.dataTransfer?.types.includes("Files")) e.preventDefault();
  }

  /** After Remove: the next chip, then the previous one, then Attach (§8.4). */
  function removeAndRefocus(index: number, remove: () => void) {
    const frame = p.frameRef.current;
    const hadFocus = !!frame?.querySelector("[data-file-chips]")?.contains(document.activeElement);
    remove();
    if (!hadFocus) return;
    setTimeout(() => {
      const buttons = frame?.querySelectorAll<HTMLElement>('[data-file-chips] [data-file-chip] button[aria-label^="Remove "]');
      const target = buttons?.[index] ?? buttons?.[index - 1] ?? frame?.querySelector<HTMLElement>('[role="button"][aria-label^="Attach"]');
      target?.focus();
    }, 0);
  }

  const pointer = useMediaQuery("(min-width: 900px)");
  const files = p.onPickFiles ? p.files : undefined;
  const fileCount = (files?.queued.length ?? 0) + (files?.stored.length ?? 0);
  // The trigger's name lists what its menu offers, in menu order (#3045):
  // live conversation is reached through the paperclip, so the paperclip says
  // so whenever the row is there. The kit paints the same string as the
  // pointer tooltip; a phone's sheet names the actions in its subtitle.
  // Desktop with composer files: one unrestricted Files action (desktop
  // menu A, #3155); phones keep Photo library and Camera beside it.
  const desktopFiles = pointer && !!p.onPickFiles;
  const attachLabel = p.onConversation ? `Attach — live conversation, ${desktopFiles ? "files" : "photo, camera, files"}` : desktopFiles ? "Attach — files" : undefined;
  const attachSubtitle = p.onPickFiles
    ? `${p.onConversation ? "Live conversation, photo" : "Photo"}, camera, files or paste.`
    : `${p.onConversation ? "Live conversation, photo" : "Photo"}, camera, ${p.onPickTracks ? "track files, " : ""}or paste.`;
  const attachMenu = (
    <div className={pointer ? "bk-focus-clip flex flex-col rounded-[inherit]" : "flex flex-col"}>
      {p.onConversation && <ListRow variant="group" icon="mic" iconTone="teal" title="Live conversation" subtitle="Talk while your agent works" onClick={p.onConversation} />}
      {!desktopFiles && <ListRow variant="group" icon="image" iconTone="teal" title="Photo library" subtitle="Pick images already on this device" onClick={p.onPickLibrary} />}
      {!desktopFiles && <ListRow variant="group" icon="attach" iconTone="amber" title="Camera" subtitle="Take a photo now" onClick={p.onPickCamera} />}
      {p.onPickFiles
        ? <ListRow variant="group" icon="file" iconTone="teal" title={desktopFiles ? "Files…" : "Files"} subtitle="Images, PDFs, tracks, any file" onClick={p.onPickFiles} />
        : p.onPickTracks && <ListRow variant="group" icon="file" iconTone="teal" title="Track files" subtitle="GPX, KML or GeoJSON" onClick={p.onPickTracks} />}
      <ListRow variant="group" icon="copy" iconTone="neutral" title={desktopFiles ? "Paste or drop" : "Paste"}
        subtitle={p.onPickFiles ? desktopFiles ? "Files paste or drop into the field" : "Files paste into the field" : "Images and track files paste into the field"} last />
    </div>
  );

  return (
    <div ref={p.frameRef} data-composer="" className="relative mx-auto max-w-3xl" onKeyDown={onKeyDown} onPaste={onPaste} onDrop={onDrop} onDragOver={onDragOver}>
      {p.dictation}
      {p.dictationNotice && (
        <div className="mb-2 flex items-start gap-2" role="status" data-capture-notice="dictation" onPointerDown={(event) => {
          const button = (event.target as HTMLElement).closest('[role="button"]');
          if (button && button !== document.activeElement) event.preventDefault();
        }}>
          <div data-capture-message="" className="min-w-0 flex-1"><Callout tone="amber" variant="boxed" icon="mic" text={p.dictationNotice} /></div>
          <Button label="Dismiss" ariaLabel="Dismiss dictation notice" tone="quiet" size="sm" block={false} reach onClick={p.onDismissDictationNotice} />
        </div>
      )}
      {p.captureNotice && p.captureNotice !== p.dictationNotice && (
        <div className="mb-2 flex items-start gap-2" role="status" data-capture-notice="local" onPointerDown={(event) => {
          const button = (event.target as HTMLElement).closest('[role="button"]');
          if (button && button !== document.activeElement) event.preventDefault();
        }}>
          <div data-capture-message="" className="min-w-0 flex-1"><Callout tone="amber" variant="boxed" icon="mic" text={p.captureNotice} /></div>
          {p.onDismissCaptureNotice && <Button label="Dismiss" ariaLabel="Dismiss capture notice" tone="quiet" size="sm" block={false} reach onClick={p.onDismissCaptureNotice} />}
        </div>
      )}
      {p.uploadNotice && (
        <div className="mb-2 flex items-start gap-2" role="status" data-upload-notice="">
          <div className="min-w-0 flex-1" data-upload-notice-text=""><Callout tone="gold" variant="boxed" icon="attention" text={p.uploadNotice} /></div>
          {p.onDismissUploadNotice && <Button label="Dismiss" ariaLabel="Dismiss upload notice" tone="quiet" size="sm" block={false} reach onClick={p.onDismissUploadNotice} />}
        </div>
      )}
      {p.attachErrors.length > 0 && (
        <div className="mb-2 flex items-start gap-2" role="alert">
          <div className="min-w-0 flex-1">
            <Callout tone="red" variant="banner" icon="failed" mono text={p.attachErrors.join(" · ")} />
          </div>
          <Button label="Dismiss" tone="quiet" size="sm" block={false} onClick={p.onDismissErrors} />
        </div>
      )}

      {p.attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {p.attachments.map((a, i) => (
            <div key={i} className="relative h-16 w-16 shrink-0">
              <img src={a.previewUrl} alt={a.name} className="h-16 w-16 rounded-lg border border-border object-cover" />
              <IconButton size="sm" tone="overlay" name={`Remove ${a.name}`} glyph={<X />}
                style={{ position: "absolute", top: -8, right: -8 }} onClick={() => p.onRemoveAttachment(i)} />
            </div>
          ))}
        </div>
      )}

      {p.onPickFiles && <div className="sr-only" aria-live="polite" data-file-announcement="">{p.fileAnnouncement ?? ""}</div>}
      {fileCount > 0 && files && <div className="mb-2 grid gap-2" data-file-chips="">
        {files.queued.map((item, i) => <FileChip key={item.id} queued={item}
          onRemove={() => removeAndRefocus(i, () => p.onRemoveQueuedFile?.(item.id))} onRetry={() => p.onRetryQueuedFile?.(item.id)} />)}
        {files.stored.map((entry, i) => <FileChip key={entry.file.fileId} stored={entry.file} detached={entry.detached} image={entry.image}
          onRemove={() => removeAndRefocus(files.queued.length + i, () => p.onRemoveStoredFile?.(entry.file.fileId))} />)}
      </div>}

      {!!p.tracks?.length && <div className="mb-2 grid gap-2" aria-live="polite">{p.tracks.map(track => <TrackChip key={track.id} track={track} onRemove={() => p.onRemoveTrack?.(track.id)} onRetry={() => p.onRetryTrack?.(track.id)} />)}</div>}

      {p.palette}

      {/* The provider list, anchored above the field: the chip that opens it
          sits in the kit's hint line, so the list is the frame's. */}
      {p.provider?.menuOpen && <ModelPicker id={pickerId} containerRef={p.providerMenuRef}
        chat={p.chatProfile} models={p.provider.options} selectedModelId={p.provider.selectedId} modelLocked={p.provider.locked}
        phone={!pointer} defaultEffort={p.provider.defaultEffort} effortLevels={p.provider.effortLevels}
        selectedEffort={p.provider.selectedEffort ?? null} onModel={p.onProviderSelect}
        {...(p.provider.lockedAction ? { lockedAction: p.provider.lockedAction } : {})}
        onEffort={(level) => { if (level === null || isThinkingLevel(level)) p.onEffortSelect(level); }} onDismiss={p.onProviderDismiss} />}

      {/* Capture is a MENU behind the paperclip (D37): a popover on a pointer
          screen, the kit sheet on a phone. */}
      {p.attachMenuOpen && pointer && (
        <div role="menu" aria-label="Attach" className="absolute bottom-full left-4 z-popover mb-1 w-72 overflow-hidden rounded-xl border border-[var(--bk-color-edge)] bg-[var(--bk-color-raised)] shadow-2xl">
          {attachMenu}
        </div>
      )}
      <Overlay open={p.attachMenuOpen && !pointer} variant="sheet" title="Attach" data-overlay-site="attach"
        subtitle={attachSubtitle}
        onClose={p.onAttachToggle}>
        {attachMenu}
      </Overlay>

      <KitComposer
        variant="send"
        state={p.state}
        placeholder={p.placeholder}
        hint={p.hint}
        blockedWhy={p.blockedWhy}
        value={p.value}
        provider={p.provider?.label}
        providerDetail={p.provider?.selectedEffort}
        providerDetailExplanation={p.provider?.effortExplanation}
        providerExpanded={p.provider?.menuOpen}
        providerControls={pickerId}
        onProvider={p.provider && (!p.provider.locked || p.provider.effortLevels?.length || p.provider.lockedAction || p.chatProfile) ? p.onProviderToggle : undefined}
        onChange={p.onChange}
        onSend={p.onSend}
        onStop={p.onStop}
        onAttach={p.onAttachToggle}
        attachLabel={attachLabel}
        onMic={p.onMic}
        mic={p.mic}
        micLabel={p.micLabel}
        micTip={p.micTip}
        micUnavailable={p.micUnavailable}
        status={p.status}
      />
    </div>
  );
}
