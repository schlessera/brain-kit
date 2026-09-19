import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy } from "lucide-react";
import type { MintedAgent } from "../../lib/api-client.js";
import { usePrincipalStore } from "../../stores/principal-store.js";

/** App-level portal for the unrecoverable value returned by an agent mint. */
export function OneTimeAgentCredentialDialog() {
  const credential = usePrincipalStore((state) => state.oneTimeCredential);
  const acknowledge = usePrincipalStore(
    (state) => state.acknowledgeAgentCredential
  );

  return credential ? (
    <OneTimeCredential
      key={credential.id}
      credential={credential}
      onDone={acknowledge}
    />
  ) : null;
}

function OneTimeCredential({
  credential,
  onDone,
}: {
  credential: MintedAgent;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const keepDialogOpen = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled])'
        ) ?? []
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keepDialogOpen, true);
    return () => window.removeEventListener("keydown", keepDialogOpen, true);
  }, []);

  async function copyCredential() {
    try {
      await navigator.clipboard.writeText(credential.cookie);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="one-time-credential-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
      >
        <h3 id="one-time-credential-title" className="text-base font-semibold text-foreground">
          Save this credential now
        </h3>
        <p className="mt-2 text-sm font-medium text-destructive">
          This is the only time you will see this value.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Store it somewhere safe before continuing. It cannot be recovered later.
        </p>
        <div className="mt-4 rounded-lg border border-border-subtle bg-background p-3">
          <code className="block break-all text-xs text-foreground">{credential.cookie}</code>
        </div>
        <button
          autoFocus
          type="button"
          onClick={() => void copyCredential()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy credential"}
        </button>
        {copyError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            Copy failed. Select the value above and copy it manually.
          </p>
        ) : null}
        <label className="mt-4 flex items-start gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
            className="mt-0.5"
          />
          I have saved this credential somewhere safe.
        </label>
        <button
          type="button"
          disabled={!saved}
          onClick={onDone}
          className="mt-3 w-full rounded-lg bg-primary-fill px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
        >
          Done
        </button>
      </div>
    </div>,
    document.body
  );
}
