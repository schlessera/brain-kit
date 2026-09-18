import { useCallback, useEffect, useRef, useState } from "react";
import type { PasskeySummary } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { isUserCancel, registerPasskey, supportsPasskeys } from "../../lib/passkeys.js";
import { PasskeyList } from "./passkey-list.js";

/**
 * Passkey management + sign out — the Security tab of the settings panel.
 * Registration requires the current session (routes are behind the auth guard);
 * credentials are RP-scoped, so entries registered on another hostname are
 * badged and only useful there.
 *
 * `active` is "this tab is on screen": the list reloads when it becomes visible
 * rather than on mount, so switching tabs picks up changes made elsewhere.
 *
 * This is the container (S6): the request, the ceremony, the per-root abort
 * signal and the confirm dialog live here; `PasskeyList` draws from props.
 */
export function PasskeyTab({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = root.api;
  const lifetime = useRef(new AbortController());
  const listRequest = useRef(0);
  const [credentials, setCredentials] = useState<PasskeySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyMode, setPasskeyMode] = useState(true);

  const webAuthnSupported = supportsPasskeys();

  const refresh = useCallback(async () => {
    const signal = lifetime.current.signal;
    const request = ++listRequest.current;
    const current = () => !signal.aborted && request === listRequest.current;
    setLoading(true);
    try {
      const data = await api.passkeyList();
      if (!current()) return;
      setCredentials(data.credentials);
      setPasskeyMode(true);
    } catch {
      if (!current()) return;
      // 400 = server not in password mode; anything else degrades the same way.
      setPasskeyMode(false);
      setCredentials([]);
    } finally {
      if (current()) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setCredentials([]);
    setLoading(false);
    setBusy(false);
    setError(null);
    setPasskeyMode(true);
    if (active) void refresh();
    return () => controller.abort();
  }, [active, root, refresh]);

  async function onAdd() {
    if (busy) return;
    const signal = lifetime.current.signal;
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(api, undefined, signal);
      if (signal.aborted) return;
      await refresh();
    } catch (err) {
      if (!signal.aborted && !isUserCancel(err)) {
        setError(err instanceof Error ? err.message : "Registration failed");
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("Remove this passkey? You can't undo this.")) return;
    const signal = lifetime.current.signal;
    setError(null);
    try {
      await api.passkeyDelete(id);
      if (signal.aborted) return;
      setCredentials((rows) => rows.filter((row) => row.id !== id));
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function onRename(id: string, label: string) {
    const signal = lifetime.current.signal;
    setError(null);
    try {
      await api.passkeyRename(id, label);
      if (signal.aborted) return;
      setCredentials((rows) =>
        rows.map((row) => (row.id === id ? { ...row, label } : row))
      );
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : "Rename failed");
    }
  }

  async function onSignOut() {
    const signal = lifetime.current.signal;
    try {
      await api.logout();
    } finally {
      if (!signal.aborted) window.location.reload();
    }
  }

  return (
    <PasskeyList
      credentials={credentials}
      status={loading ? "loading" : passkeyMode ? "ready" : "unavailable"}
      busy={busy}
      error={error}
      supported={webAuthnSupported}
      hostname={typeof window !== "undefined" ? window.location.hostname : ""}
      onAdd={() => void onAdd()}
      onRename={(id, label) => void onRename(id, label)}
      onDelete={(id) => void onDelete(id)}
      onSignOut={() => void onSignOut()}
    />
  );
}
