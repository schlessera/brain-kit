import { useBrainUiRoot } from "../root-context.js";
import { useCallback, useEffect, useRef } from "react";
import {
  SHARE_STASH_TTL_MS,
  type ShareIntakeResult,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  getShareStore,
  pruneStoredShares,
  readShareLaunchParams,
  type StoredShare,
} from "@schlessera/brain-ui-sdk/share-target";
import { useConnectionStore } from "../stores/connection-store.js";
import { useShareStore } from "../stores/share-store.js";
import { detectClientEnvironment } from "../lib/client-environment.js";
import {
  buildSharePrompt,
  describeShareError,
  describeUploadError,
  dropShareClaim,
  persistShareClaim,
  readShareClaims,
  shareImagesToAttachments,
  uploadShare,
} from "../lib/share-intake.js";

/**
 * Pick up shares the service worker stashed, and file them once confirmed.
 *
 * Deliberately thin: every decision lives in `lib/share-intake.ts`, which is
 * testable without a DOM. What is left here is the browser-only part — reading
 * the launch URL, rewriting it, and driving the stores.
 */

/**
 * Move `?share=<id>` out of the URL and into a durable claim.
 *
 * The parameter cannot stay: the shell reloads the page when a new service
 * worker takes over, a reload preserves the query string, and a second pass
 * over the same id while the first upload is in flight would file the share
 * twice. (The claim is belt; `store.take()` is braces — it hands the record to
 * exactly one caller.)
 */
function claimFromLocation(): { claimed: string[]; error?: string } {
  if (typeof window === "undefined") return { claimed: [] };
  const { shareId, error } = readShareLaunchParams(window.location.href);
  if (shareId) {
    persistShareClaim(shareId);
    const url = new URL(window.location.href);
    url.searchParams.delete("share");
    url.searchParams.delete("share_error");
    history.replaceState(null, "", url.toString());
  } else if (error) {
    const url = new URL(window.location.href);
    url.searchParams.delete("share_error");
    history.replaceState(null, "", url.toString());
  }
  return {
    claimed: readShareClaims(),
    ...(error ? { error: describeShareError(error) } : {}),
  };
}

export function useShareIntake(): {
  confirm: (record: StoredShare) => Promise<void>;
  dismiss: (record: StoredShare) => void;
} {
  const root = useBrainUiRoot();
  const canUpload = useCallback(() => root.stores.connection.getState().wsStatus === "connected" && navigator.onLine !== false, [root]);
  const activeUpload = useRef<{ id: string; record: StoredShare; controller: AbortController } | null>(null);
  const waiting = useRef<StoredShare | null>(null);
  const wsStatus = useConnectionStore(state => state.wsStatus);
  const busy = useShareStore(state => state.busy);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [root]);
  const enqueue = useShareStore((s) => s.enqueue);
  const remove = useShareStore((s) => s.remove);
  const setBusy = useShareStore((s) => s.setBusy);
  const setError = useShareStore((s) => s.setError);
  const setNotes = useShareStore((s) => s.setNotes);

  useEffect(() => {
    let disposed = false;
    const { claimed, error } = claimFromLocation();
    if (error) setError(error);

    void (async () => {
      const store = getShareStore();
      try {
        for (const id of claimed) {
          const record = await store.take(id);
          if (disposed) {
            if (record) await store.put(record);
            return;
          }
          dropShareClaim(id);
          if (record) enqueue(record);
        }

        // Orphans: a share whose landing page never ran (the app opened
        // offline on the fallback page, or the tab was closed before the
        // parameter was read) leaves a record nobody holds the id for. The
        // stash is the only place it still exists.
        for (const record of await store.list()) {
          if (disposed) return;
          const taken = await store.take(record.id);
          if (disposed) {
            if (taken) await store.put(taken);
            return;
          }
          if (taken) enqueue(taken);
        }

        // The service worker's own prune runs after a stash, so it can never
        // reach the newest record. This pass can.
        await pruneStoredShares(store, SHARE_STASH_TTL_MS);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : "Could not read stashed shares");
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [enqueue, setError]);

  const confirm = useCallback(
    async (record: StoredShare) => {
      const controller = new AbortController();
      const owner = lifetime.current.signal;
      if (owner.aborted) return;
      const abort = () => controller.abort();
      owner.addEventListener("abort", abort, { once: true });
      const signal = controller.signal;
      const share = root.stores.share.getState();
      if (share.busy) { owner.removeEventListener("abort", abort); return; }
      if (!canUpload()) {
        waiting.current = record;
        owner.removeEventListener("abort", abort);
        share.setPhase("paused");
        setError("Waiting for connection. Your confirmed share will resume automatically.");
        return;
      }

      waiting.current = null;
      activeUpload.current = { id: record.id, record, controller };
      share.setPhase("uploading");
      setBusy(true);
      setError(null);
      setNotes([]);
      try {
        const outcome = await uploadShare(record, root.request, root.apiBase(), signal, () => { if (!signal.aborted) share.setPhase("parsing"); });
        if (signal.aborted) return;
        if (!outcome.ok) {
          if (!canUpload()) waiting.current = record;
          setError(describeUploadError(outcome));
          return;
        }

        const { attachments, errors } = await shareImagesToAttachments(record.files);
        if (signal.aborted) {
          for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
          return;
        }
        if (errors.length) setNotes(errors);

        const prompt = buildSharePrompt(outcome.result as ShareIntakeResult);
        const chat = root.stores.chat.getState();
        // Always start from a fresh draft: `activeSessionId` is restored from
        // localStorage at store creation, so on a cold boot it already points
        // at whatever session was last open.
        chat.clearMessages();
        // Ownership of the preview URLs transfers to the message here — the
        // chat store revokes them. Nothing below may revoke them again.
        const trackFiles = outcome.result.files.filter(file => file.detected && file.summary);
        chat.addUserMessage(
          null,
          prompt,
          "typed",
          attachments.length
            ? attachments.map((a) => ({
                previewUrl: a.previewUrl,
                mediaType: a.attachment.mediaType,
              }))
            : undefined,
          undefined,
          trackFiles.length ? trackFiles : undefined
        );
        chat.startAssistantMessage(null);

        const sent = root.connection.send({
          type: "chat_message",
          text: prompt,
          ...(trackFiles.length ? { files: trackFiles.map(file => ({ kind: "file" as const, path: file.path })) } : {}),
          ...(attachments.length
            ? { attachments: attachments.map((a) => a.attachment) }
            : {}),
          ...(detectClientEnvironment() ? { client: detectClientEnvironment() } : {}),
          source: "typed",
        });
        if (!sent) {
          setError("The connection dropped before that could be sent.");
          return;
        }

        remove(record.id);
        dropShareClaim(record.id);
      } finally {
        owner.removeEventListener("abort", abort);
        activeUpload.current = null;
        setBusy(false);
        if (waiting.current) root.stores.share.getState().setPhase("paused");
      }
    },
    [remove, setBusy, setError, setNotes, root, canUpload]
  );

  // Only a share the reader already confirmed may resume automatically.
  useEffect(() => {
    const connectionChanged = () => {
      const online = root.stores.connection.getState().wsStatus === "connected" && navigator.onLine !== false;
      const active = activeUpload.current;
      if (!online && active) {
        waiting.current = active.record;
        active.controller.abort();
        setError("Waiting for connection. Your confirmed share will resume automatically.");
      }
      const record = waiting.current;
      if (online && record && !root.stores.share.getState().busy && root.stores.share.getState().queue.some(item => item.id === record.id)) void confirm(record);
    };
    connectionChanged();
    window.addEventListener("online", connectionChanged);
    window.addEventListener("offline", connectionChanged);
    return () => { window.removeEventListener("online", connectionChanged); window.removeEventListener("offline", connectionChanged); };
  }, [root, wsStatus, busy, confirm, setError]);

  const dismiss = useCallback(
    (record: StoredShare) => {
      if (waiting.current?.id === record.id) waiting.current = null;
      if (activeUpload.current?.id === record.id) activeUpload.current.controller.abort();
      remove(record.id);
      dropShareClaim(record.id);
      setError(null);
      // Already taken out of the stash when it was claimed; dropping the queue
      // entry is what discards it.
    },
    [remove, setError]
  );

  return { confirm, dismiss };
}
