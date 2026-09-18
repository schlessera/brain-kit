import { Button, Chip, Placeholder } from "@schlessera/brain-ui-kit";
import { Check, Fingerprint, Pencil, Trash2, X } from "lucide-react";
import type { PasskeySummary } from "@schlessera/brain-ui-sdk/protocol";
import { useState } from "react";

/**
 * The Security tab's surface, rendered from props (S6). `PasskeyTab` is the
 * container: it owns the list request, the registration ceremony, the
 * per-root abort signal and the confirm dialog; this owns what is on screen.
 *
 * `status` is the three-way answer the list request gives: `loading` while
 * it is in flight, `ready` when the server is in password mode, and
 * `unavailable` when it is not (a 400 from the list route, or anything else
 * that degrades the same way). The Add button appears only when passkeys are
 * possible here — server mode AND a browser that can do WebAuthn.
 *
 * The Add and Sign-out buttons are the kit's. The per-row rename and remove
 * controls stay native icon buttons: the kit has no icon-only button and a
 * `ListRow`'s trailing action is decorative. Rename state (which row is being
 * edited, the draft) is the row's own and never leaves the view.
 */
export type PasskeyStatus = "loading" | "ready" | "unavailable";

export interface PasskeyListProps {
  credentials: PasskeySummary[];
  status: PasskeyStatus;
  /** A registration ceremony is in flight. */
  busy: boolean;
  error: string | null;
  /** The browser can do WebAuthn at all. */
  supported: boolean;
  /** The hostname this page is served from; a credential registered elsewhere is badged. */
  hostname: string;
  onAdd: () => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
}

export function PasskeyList(p: PasskeyListProps) {
  const canAdd = p.status === "ready" && p.supported;
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Passkeys
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Sign in with Face ID, fingerprint, or a security key instead of the
          password. Passkeys only work on the site they were added on.
        </p>

        {p.status === "loading" ? (
          <div className="mt-4">
            <Placeholder variant="loading" lines={2} />
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {p.credentials.map((credential) => (
              <PasskeyRow
                key={credential.id}
                credential={credential}
                foreign={credential.rpId !== p.hostname}
                onDelete={() => p.onDelete(credential.id)}
                onRename={(label) => p.onRename(credential.id, label)}
              />
            ))}
            {p.credentials.length === 0 && p.status === "ready" && (
              <li>
                <Placeholder variant="empty" message="No passkeys yet." icon="passkey" />
              </li>
            )}
          </ul>
        )}

        {p.error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {p.error}
          </p>
        )}

        {canAdd ? (
          <div className="mt-4">
            <Button
              label={p.busy ? "Adding a passkey…" : "Add a passkey"}
              icon="add"
              tone="primary"
              size="md"
              center
              disabled={p.busy}
              onClick={p.onAdd}
            />
          </div>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">
            {p.status === "unavailable"
              ? "Passkeys need password auth mode on the server."
              : "This browser does not support passkeys."}
          </p>
        )}
      </div>

      {/* Sign out everywhere */}
      <div className="border-t border-border p-4">
        <Button label="Sign out everywhere" icon="hand" tone="danger" size="md" center onClick={p.onSignOut} />
      </div>
    </div>
  );
}

function PasskeyRow({
  credential,
  foreign,
  onDelete,
  onRename,
}: {
  credential: PasskeySummary;
  foreign: boolean;
  onDelete: () => void;
  onRename: (label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(credential.label);

  const displayName =
    credential.label ||
    `Passkey · ${new Date(credential.createdAt).toLocaleDateString()}`;

  function commit() {
    setEditing(false);
    const label = draft.trim();
    if (label !== credential.label) onRename(label);
  }

  return (
    <li className="rounded-lg border border-border-subtle bg-surface p-3">
      <div className="flex items-center gap-2">
        <Fingerprint className="h-4 w-4 shrink-0 text-primary" />
        {editing ? (
          <span className="flex flex-1 items-center gap-1">
            <input
              autoFocus
              value={draft}
              aria-label="Passkey name"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-full rounded border border-border-subtle bg-background px-2 py-0.5 text-sm text-foreground outline-none focus:border-primary"
            />
            <button type="button" onClick={commit} title="Save" className="p-1 text-muted-foreground hover:text-foreground">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setEditing(false)} title="Cancel" className="p-1 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <span className="flex-1 truncate text-sm text-foreground">{displayName}</span>
        )}
        {!editing && (
          <>
            <button
              type="button"
              onClick={() => {
                setDraft(credential.label);
                setEditing(true);
              }}
              title="Rename"
              className="p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              title="Remove"
              className="p-1 text-muted-foreground transition-colors hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-muted-foreground">
        {credential.backedUp && <Chip label="synced" variant="kv" tone="teal" />}
        {foreign && (
          <span title={`Registered on ${credential.rpId}; only usable there.`} className="flex">
            <Chip label={credential.rpId} variant="mono" tone="neutral" />
          </span>
        )}
        <span>
          {credential.lastUsedAt
            ? `Last used ${new Date(credential.lastUsedAt).toLocaleDateString()}`
            : `Added ${new Date(credential.createdAt).toLocaleDateString()}`}
        </span>
      </div>
    </li>
  );
}
