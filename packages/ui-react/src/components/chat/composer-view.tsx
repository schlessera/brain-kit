import { Button, Callout, Chip, Icon } from "@schlessera/brain-ui-kit";
import { X } from "lucide-react";
import type { ClipboardEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { cn } from "../../lib/utils.js";
import { MicButton } from "../voice/mic-button.js";

/**
 * The composer's field, rendered from props (S7, the `chat` directory).
 * `Composer` is the container: it owns the draft, the attachments and their
 * object URLs, the provider choice, the voice review, the command palette's
 * open state and every store read; this owns how the field looks and which
 * keys mean what inside it.
 *
 * The kit's `Composer` is the design's field as a display component, and its
 * API stops at attach / mic / send. The app's field also needs a camera, a
 * stop, a recall, a provider picker, paste-to-attach, a connection-aware
 * placeholder, a desktop-only ⏎ and a CSS-grown textarea whose ref the
 * container focuses — so this view draws the design's field from the kit's
 * primitives (`Icon`, `Button`, `Chip`, `Callout`) around the app's own
 * textarea, on the kit's tokens, rather than forcing the kit component to
 * grow eight props it has no story for.
 *
 * Keys: ⏎ sends on a pointer-width screen and inserts a newline on a phone;
 * ⇧⏎ is always a newline; ↑ on an empty draft recalls the last prompt; esc
 * dismisses the command palette. When the palette is open ⏎ belongs to it.
 */
export interface ComposerAttachment {
  previewUrl: string;
  name: string;
}

export interface ComposerProvider {
  label: string;
  /** Fixed for this conversation: the trigger is inert and says so. */
  locked: boolean;
  menuOpen: boolean;
  options: { id: string; label: string }[];
  selectedId: string | null;
}

export interface ComposerViewProps {
  value: string;
  placeholder: string;
  /** No connection: the field and every control are inert. */
  disabled: boolean;
  /** A turn is streaming: attach and mic are inert, and with no draft the primary action is Stop. */
  streaming: boolean;
  canSend: boolean;
  hasDraft: boolean;
  /** "Follows up live" / "Will queue" while a session is running, else null. */
  followUpHint: string | null;
  showRecall: boolean;
  micActive: boolean;
  paletteOpen: boolean;
  /** The command palette, already rendered by the container, or null. */
  palette: ReactNode;
  attachments: ComposerAttachment[];
  attachErrors: string[];
  provider: ComposerProvider | null;
  /** The container's ref: it focuses the field after a recall or a voice edit. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The container's ref for the provider popover's outside-click dismissal. */
  providerMenuRef: RefObject<HTMLDivElement | null>;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onPasteFiles: (files: File[]) => void;
  onAttach: () => void;
  onCamera: () => void;
  onRecall: () => void;
  onMic: () => void;
  onEscape: () => void;
  onRemoveAttachment: (index: number) => void;
  onDismissErrors: () => void;
  onProviderToggle: () => void;
  onProviderSelect: (id: string) => void;
}

export function ComposerView(p: ComposerViewProps) {
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      if (p.paletteOpen) return;
      // A pointer-width screen sends on ⏎; a phone (or a runtime with no
      // media queries) keeps ⏎ as a newline and sends from the button.
      if (typeof window.matchMedia === "function" && window.matchMedia("(min-width: 768px)").matches) {
        e.preventDefault();
        p.onSubmit();
      }
    }
    if (e.key === "ArrowUp" && !p.value.trim()) p.onRecall();
    if (e.key === "Escape") p.onEscape();
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    p.onPasteFiles(images);
  }

  const inert = p.disabled || p.streaming;

  return (
    <div className="mx-auto max-w-3xl">
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

      <div
        className={cn(
          "relative rounded-[20px] border shadow-lg transition-all duration-200",
          "border-[var(--bk-color-edge)] bg-[var(--bk-color-surface)]",
          "focus-within:border-[var(--bk-hover-border)] focus-within:shadow-[0_0_20px_var(--bk-composer-voice-glow)]",
        )}
      >
        {p.palette}

        {/* The textarea grows by CSS, not by JavaScript: the wrapper's ::after
            mirrors the value and sets the row height, so the composer never
            reads scrollHeight. That read forced a full document layout on
            every keystroke, and its cost scaled with the transcript. */}
        <div className="composer-grow" data-value={p.value + " "}>
          <textarea
            ref={p.textareaRef}
            value={p.value}
            onChange={(e) => p.onChange(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            placeholder={p.placeholder}
            aria-label={p.placeholder}
            disabled={p.disabled}
            rows={1}
            className="bk-composer w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex min-w-0 items-center gap-3 text-[11px] text-muted-foreground/50">
            {p.provider && (
              <div ref={p.providerMenuRef} className="relative">
                <span title={p.provider.locked ? "Provider is fixed for this conversation" : "Choose model"} className="flex max-w-[9rem] md:max-w-[14rem]">
                  <Button
                    label={p.provider.label}
                    icon={p.provider.locked ? "secure" : "model"}
                    tone="quiet"
                    size="sm"
                    block={false}
                    disabled={p.provider.locked}
                    onClick={p.onProviderToggle}
                  />
                </span>
                {p.provider.menuOpen && !p.provider.locked && (
                  <div
                    role="menu"
                    className="absolute bottom-full left-0 z-50 mb-1 min-w-[14rem] overflow-hidden rounded-xl border border-[var(--bk-color-edge)] bg-[var(--bk-color-raised)] py-1 shadow-2xl"
                  >
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
              </div>
            )}
            {p.followUpHint ? (
              <Chip label={p.followUpHint} variant="mono" tone="amber" />
            ) : (
              <>
                <span className="hidden sm:inline">
                  <span className="font-[family-name:var(--font-mono)]">/</span> for commands
                </span>
                <span className="hidden md:inline">Shift+Enter for newline</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <ToolButton label="Attach images" icon="attach" disabled={inert} onClick={p.onAttach} />
            <ToolButton label="Take a photo" icon="image" disabled={inert} onClick={p.onCamera} />
            {p.showRecall && <ToolButton label="Recall last prompt" icon="revert" onClick={p.onRecall} />}
            <MicButton active={p.micActive} disabled={inert} onTap={p.onMic} />
            {p.streaming && !p.hasDraft ? (
              // Streaming with nothing drafted: the primary action is Stop.
              <button
                type="button"
                onClick={p.onCancel}
                title="Stop the running turn"
                aria-label="Stop the running turn"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bk-red-fill)] transition-all duration-150 hover:brightness-110"
              >
                <Icon icon="pause" size={15} color="var(--bk-on-fill)" />
              </button>
            ) : (
              // A draft always sends — as a new turn, or a follow-up when a
              // session is already running.
              <button
                type="button"
                onClick={p.onSubmit}
                disabled={!p.canSend}
                title={p.followUpHint ?? "Send"}
                aria-label="Send"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bk-amber-fill)] transition-all duration-150 hover:brightness-110 disabled:opacity-30"
              >
                <Icon icon="send" size={15} color="var(--bk-on-fill)" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolButton({ label, icon, disabled, onClick }: { label: string; icon: "attach" | "image" | "revert"; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150 hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
    >
      <Icon icon={icon} size={16} />
    </button>
  );
}
