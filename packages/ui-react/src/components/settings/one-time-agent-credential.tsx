import { useRef, useState } from "react";
import { Button, Overlay } from "@schlessera/brain-ui-kit";
import type { MintedAgent } from "../../lib/api-client.js";
import { usePrincipalStore } from "../../stores/principal-store.js";

/** App-level dialog for the unrecoverable value returned by an agent mint. */
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
  const copyRef = useRef<HTMLElement>(null);
  const shell = useRef<Document | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  async function copyCredential() {
    try {
      await navigator.clipboard.writeText(credential.cookie);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <Overlay open variant="dialog" role="alertdialog" size="md" closedBy="none"
      labelledBy="one-time-credential-title" initialFocus={copyRef} onClose={() => {}}
      surfaceRef={node => {
        if (!node) return;
        if (!shell.current) opener.current = node.ownerDocument.activeElement as HTMLElement | null;
        shell.current = node.ownerDocument;
      }}
      returnFocus={() => {
        if (opener.current?.isConnected && !opener.current.matches(":disabled")) return opener.current;
        // Mint clears the label and disables its submit, so that opener may
        // no longer take focus. The selected Settings tab remains a live stop.
        const settings = shell.current?.querySelector<HTMLElement>('[data-panel="Settings"], section[aria-label="Settings"]');
        return settings?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
      }}>
      <div>
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
        <div className="mt-3" ref={node => { copyRef.current = node?.querySelector<HTMLElement>('[role="button"]') ?? null; }}>
          <Button label={copied ? "Copied" : "Copy credential"} tone="ghost" size="md" center block={false} icon={copied ? "confirm" : "copy"} style={{ minHeight: 44, width: "100%" }} onClick={() => void copyCredential()} />
        </div>
        {copyError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            Copy failed. Select the value above and copy it manually.
          </p>
        ) : null}
        <label className="mt-4 flex min-h-11 items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
            className="mt-0.5"
          />
          I have saved this credential somewhere safe.
        </label>
        <div className="mt-3"><Button label="Done" tone="primary" size="md" center block={false} disabled={!saved} style={{ minHeight: 44, width: "100%" }} onClick={onDone} /></div>
      </div>
    </Overlay>
  );
}
