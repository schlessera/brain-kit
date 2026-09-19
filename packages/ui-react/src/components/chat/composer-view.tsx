import { BottomSheet, Button, Callout, Composer as KitComposer, Icon, ListRow, type ComposerState } from "@schlessera/brain-ui-kit";
import { X } from "lucide-react";
import type { ClipboardEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { cn } from "../../lib/utils.js";

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
export interface ComposerAttachment {
  previewUrl: string;
  name: string;
}

export interface ComposerProvider {
  label: string;
  /** Fixed for this conversation: the chip is text, not a control. */
  locked: boolean;
  menuOpen: boolean;
  options: { id: string; label: string }[];
  selectedId: string | null;
}

export interface ComposerViewProps {
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
  attachErrors: string[];
  provider: ComposerProvider | null;
  /** The container's ref: it focuses the field after a recall or a voice edit. */
  frameRef: RefObject<HTMLDivElement | null>;
  /** The container's ref for the provider popover's outside-click dismissal. */
  providerMenuRef: RefObject<HTMLDivElement | null>;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onMic: () => void;
  onAttachToggle: () => void;
  onPickLibrary: () => void;
  onPickCamera: () => void;
  onPasteFiles: (files: File[]) => void;
  onRecall: () => void;
  onEscape: () => void;
  onRemoveAttachment: (index: number) => void;
  onDismissErrors: () => void;
  onProviderToggle: () => void;
  onProviderSelect: (id: string) => void;
}

export function ComposerView(p: ComposerViewProps) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).tagName !== "TEXTAREA") return;
    if (e.key === "ArrowUp" && !p.value.trim()) p.onRecall();
    if (e.key === "Escape" && p.paletteOpen) p.onEscape();
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    p.onPasteFiles(images);
  }

  const pointer = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 900px)").matches;
  const attachMenu = (
    <div className="flex flex-col">
      <ListRow variant="group" icon="image" iconTone="teal" title="Photo library" subtitle="Pick images already on this device" onClick={p.onPickLibrary} />
      <ListRow variant="group" icon="attach" iconTone="amber" title="Camera" subtitle="Take a photo now" onClick={p.onPickCamera} />
      <ListRow variant="group" icon="copy" iconTone="neutral" title="Paste" subtitle="An image on the clipboard pastes straight into the field" last />
    </div>
  );

  return (
    <div ref={p.frameRef} data-composer="" className="relative mx-auto max-w-3xl" onKeyDown={onKeyDown} onPaste={onPaste}>
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
              <button
                type="button"
                onClick={() => p.onRemoveAttachment(i)}
                title="Remove"
                aria-label={`Remove ${a.name}`}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground shadow transition-colors hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {p.palette}

      {/* The provider list, anchored above the field: the chip that opens it
          sits in the kit's hint line, so the list is the frame's. */}
      {p.provider && p.provider.menuOpen && !p.provider.locked && (
        <div ref={p.providerMenuRef} role="menu" aria-label="Model" className="absolute bottom-full left-4 z-50 mb-1 min-w-[14rem] overflow-hidden rounded-xl border border-[var(--bk-color-edge)] bg-[var(--bk-color-raised)] py-1 shadow-2xl">
          {p.provider.options.map((o) => (
            <button
              key={o.id}
              role="menuitem"
              type="button"
              onClick={() => p.onProviderSelect(o.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
            >
              <span className={cn("flex w-3.5 shrink-0", o.id === p.provider!.selectedId ? "opacity-100" : "opacity-0")}>
                <Icon icon="confirm" size={14} color="var(--bk-amber-ink)" />
              </span>
              <span className="truncate">{o.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Capture is a MENU behind the paperclip (D37): a popover on a pointer
          screen, the kit sheet on a phone. */}
      {p.attachMenuOpen && pointer && (
        <div role="menu" aria-label="Attach" className="absolute bottom-full left-4 z-50 mb-1 w-72 overflow-hidden rounded-xl border border-[var(--bk-color-edge)] bg-[var(--bk-color-raised)] shadow-2xl">
          {attachMenu}
        </div>
      )}
      {p.attachMenuOpen && !pointer && (
        <div
          className="fixed inset-0 z-40 bg-black/60"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) p.onAttachToggle();
          }}
        >
          <div role="dialog" aria-label="Attach" className="absolute inset-x-0 bottom-0">
            <BottomSheet title="Attach" subtitle="Photo, camera, or paste." docked>
              {attachMenu}
            </BottomSheet>
          </div>
        </div>
      )}

      <KitComposer
        variant="send"
        state={p.state}
        placeholder={p.placeholder}
        hint={p.hint}
        blockedWhy={p.blockedWhy}
        value={p.value}
        provider={p.provider?.label}
        onProvider={p.provider && !p.provider.locked ? p.onProviderToggle : undefined}
        onChange={p.onChange}
        onSend={p.onSend}
        onStop={p.onStop}
        onAttach={p.onAttachToggle}
        onMic={p.onMic}
      />
    </div>
  );
}
