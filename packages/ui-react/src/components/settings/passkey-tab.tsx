import { useEffect, useState } from "react";
import {
  Check,
  Cloud,
  Fingerprint,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { PasskeySummary } from "@schlessera/brain-ui-sdk/protocol";
import { api } from "../../lib/api-client.js";
import { isUserCancel, registerPasskey, supportsPasskeys } from "../../lib/passkeys.js";
import { cn } from "../../lib/utils.js";

/**
 * Passkey management + sign out — the Security tab of the settings panel.
 * Registration requires the current session (routes are behind the auth guard);
 * credentials are RP-scoped, so entries registered on another hostname are
 * badged and only useful there.
 *
 * `active` is "this tab is on screen": the list reloads when it becomes visible
 * rather than on mount, so switching tabs picks up changes made elsewhere.
 */
export function PasskeyTab({ active }: { active: boolean }) {
  const [credentials, setCredentials] = useState<PasskeySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyMode, setPasskeyMode] = useState(true);

  const webAuthnSupported = supportsPasskeys();

  async function refresh() {
    setLoading(true);
    try {
      const data = await api.passkeyList();
      setCredentials(data.credentials);
      setPasskeyMode(true);
    } catch {
      // 400 = server not in password mode; anything else degrades the same way.
      setPasskeyMode(false);
      setCredentials([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (active) {
      setError(null);
      void refresh();
    }
  }, [active]);

  async function onAdd() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await registerPasskey();
      await refresh();
    } catch (err) {
      if (!isUserCancel(err)) {
        setError(err instanceof Error ? err.message : "Registration failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("Remove this passkey? You can't undo this.")) return;
    setError(null);
    try {
      await api.passkeyDelete(id);
      setCredentials((rows) => rows.filter((row) => row.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function onRename(id: string, label: string) {
    setError(null);
    try {
      await api.passkeyRename(id, label);
      setCredentials((rows) =>
        rows.map((row) => (row.id === id ? { ...row, label } : row))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    }
  }

  async function onSignOut() {
    try {
      await api.logout();
    } finally {
      window.location.reload();
    }
  }

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

        {loading ? (
          <div className="mt-6 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {credentials.map((credential) => (
              <PasskeyRow
                key={credential.id}
                credential={credential}
                onDelete={() => onDelete(credential.id)}
                onRename={(label) => onRename(credential.id, label)}
              />
            ))}
            {credentials.length === 0 && passkeyMode && (
              <li className="rounded-lg border border-dashed border-border-subtle p-4 text-center text-xs text-muted-foreground">
                No passkeys yet.
              </li>
            )}
          </ul>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}

        {passkeyMode && webAuthnSupported ? (
          <button
            onClick={onAdd}
            disabled={busy}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Add a passkey
          </button>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">
            {passkeyMode
              ? "This browser does not support passkeys."
              : "Passkeys need password auth mode on the server."}
          </p>
        )}
      </div>

      {/* Sign out */}
      <div className="border-t border-border p-4">
        <button
          onClick={onSignOut}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-destructive hover:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </div>
  );
}

function PasskeyRow({
  credential,
  onDelete,
  onRename,
}: {
  credential: PasskeySummary;
  onDelete: () => void;
  onRename: (label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(credential.label);
  const foreignRp =
    typeof window !== "undefined" && credential.rpId !== window.location.hostname;

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
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-full rounded border border-border-subtle bg-background px-2 py-0.5 text-sm text-foreground outline-none focus:border-primary"
            />
            <button onClick={commit} title="Save" className="p-1 text-muted-foreground hover:text-foreground">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setEditing(false)} title="Cancel" className="p-1 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <span className="flex-1 truncate text-sm text-foreground">{displayName}</span>
        )}
        {!editing && (
          <>
            <button
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
              onClick={onDelete}
              title="Remove"
              className="p-1 text-muted-foreground transition-colors hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[11px] text-muted-foreground">
        {credential.backedUp && (
          <span className="flex items-center gap-1">
            <Cloud className="h-3 w-3" /> Synced
          </span>
        )}
        {foreignRp && (
          <span
            className={cn(
              "rounded bg-surface-raised px-1.5 py-0.5 font-medium text-foreground/70"
            )}
            title={`Registered on ${credential.rpId}; only usable there.`}
          >
            {credential.rpId}
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
