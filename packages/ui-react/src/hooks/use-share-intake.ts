import { useBrainUiRoot } from "../root-context.js";
import { useCallback, useEffect, useRef } from "react";
import {
  type ShareIntakeResult,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  readShareLaunchParams,
  type StoredShare,
} from "@schlessera/brain-ui-sdk/share-target";
import { useConnectionStore } from "../stores/connection-store.js";
import { useShareStore } from "../stores/share-store.js";
import { SHARE_REVIEW_PREFIX, acquireShareReviewSession, releaseShareReviewSession, type ShareReviewSession, holdShareReview, recoverShareReview, shareReviewIds, shareReviewPartition } from "../lib/share-review.js";
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
 * Input handling and persistence live in `lib/share-intake.ts` and
 * `lib/share-review.ts`. This hook drives the launch URL, account lifetime,
 * review ownership and upload lifecycle.
 */

/**
 * Move `?share=<id>` out of the URL and into a durable claim.
 *
 * The parameter cannot stay: the shell reloads the page when a new service
 * worker takes over, a reload preserves the query string, and a second pass
 * over the same id while the first upload is in flight would file the share
 * twice. Review admission now holds a native browser lock and commits the
 * original to its authenticated account partition before clearing the stash.
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
  const reviewSession = useRef<ShareReviewSession | null>(null);
  const wsStatus = useConnectionStore(state => state.wsStatus);
  const busy = useShareStore(state => state.busy);
  const queue = useShareStore(state => state.queue);
  const account = useConnectionStore(state => state.accountKey);
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
    const controller = new AbortController();
    const { error } = claimFromLocation();
    if (error) setError(error);
    if (!account) return;
    let scanning = false;
    const session = acquireShareReviewSession(root, account);
    const owner = lifetime.current.signal;
    reviewSession.current = session;
    const held = session.owners;
    const lease = session.controller.signal;
    const scan = async () => {
      if (scanning || controller.signal.aborted || lease.aborted) return;
      scanning = true;
      try {
        for (const id of await shareReviewIds(root)) {
          if (controller.signal.aborted) return;
          if (held.has(id)) continue;
          // The callback retains the native lock while this tab owns review.
          void holdShareReview(id, lease, async () => {
            const review = await recoverShareReview(root, id);
            if (!review || lease.aborted) return;
            await new Promise<void>(release => {
              const stop = () => { lease.removeEventListener("abort", stop); release(); };
              held.set(id, stop);
              lease.addEventListener("abort", stop, { once: true });
              enqueue(review.record);
              if (review.confirmed) {
                session.pending.add(review.record.id);
                if (!root.stores.share.getState().busy) root.stores.share.getState().setPhase("paused");
              }
            });
          }).catch(err => {
            if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not recover shared content");
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not read stashed shares");
      } finally { scanning = false; }
    };
    void scan();
    // A survivor recovers an owner abandoned by a terminated tab. Locks never
    // expire under a slow upload or background suspension.
    const timer = window.setInterval(() => void scan(), 1000);
    return () => {
      controller.abort(); window.clearInterval(timer);
      releaseShareReviewSession(root, session, owner);
      if (reviewSession.current === session) reviewSession.current = null;
    };
  }, [root, account, enqueue, remove, setError]);

  const confirm = useCallback(
    async (record: StoredShare) => {
      const controller = new AbortController();
      const owner = lifetime.current.signal;
      const session = reviewSession.current;
      if (!session || session.controller.signal.aborted || root.stores.connection.getState().accountKey !== session.account || owner.aborted || !session.owners.has(record.id) || !root.stores.share.getState().queue.some(row => row.id === record.id)) return;
      const abort = () => controller.abort();
      owner.addEventListener("abort", abort, { once: true });
      session.controller.signal.addEventListener("abort", abort, { once: true });
      const detach = () => { owner.removeEventListener("abort", abort); session.controller.signal.removeEventListener("abort", abort); };
      const signal = controller.signal;
      const share = root.stores.share.getState();
      if (share.busy) { detach(); return; }
      session.pending.delete(record.id);
      if (session.waiting?.id === record.id) session.waiting = null;
      // Confirmation is account-bound durable consent, committed before any
      // network operation. Failure leaves the review and original untouched.
      setBusy(true);
      try {
        await shareReviewPartition(root).put(`${SHARE_REVIEW_PREFIX}${record.id}`, { record, confirmed: true });
      } catch (err) {
        detach();
        if (!session.controller.signal.aborted) {
          setBusy(false);
          setError(err instanceof Error ? err.message : "Could not save share confirmation");
        }
        return;
      }
      if (signal.aborted || root.stores.connection.getState().accountKey !== session.account || !session.owners.has(record.id)) {
        if (!session.controller.signal.aborted) {
          if (root.stores.connection.getState().accountKey === session.account && session.owners.has(record.id)) session.waiting = record;
          setBusy(false);
        }
        detach(); return;
      }
      if (!canUpload()) {
        session.pending.add(record.id);
        session.waiting = record;
        detach();
        setBusy(false);
        share.setPhase("paused");
        setError("Waiting for connection. Your confirmed share will resume automatically.");
        return;
      }

      if (session.waiting?.id === record.id) session.waiting = null;
      session.activeUpload = { record, controller, owner };
      share.setPhase("uploading");
      setBusy(true);
      setError(null);
      setNotes([]);
      try {
        const outcome = await uploadShare(record, root.request, root.apiBase(), signal, () => { if (!signal.aborted) share.setPhase("parsing"); });
        if (signal.aborted) return;
        if (!outcome.ok) {
          if (!canUpload()) session.waiting = record;
          setError(describeUploadError(outcome));
          return;
        }

        const receipt = outcome.result;
        const metadataReceived = receipt && typeof receipt.id === "string" && receipt.id.length > 0
          && typeof receipt.dir === "string" && receipt.dir.length > 0 && Number.isFinite(receipt.receivedAt)
          && receipt.text === record.text && receipt.title === record.title && receipt.url === record.url;
        const filesReceived = receipt && Array.isArray(receipt.files) && receipt.files.length === record.files.length
          && !receipt.skipped?.length && receipt.files.every((file, index) => file && typeof file.name === "string"
            && typeof file.path === "string" && file.path.length > 0 && typeof file.mediaType === "string"
            && file.bytes === record.files[index]!.size);
        if (!metadataReceived || !filesReceived) {
          setError("The server did not acknowledge every original. Your share is kept on this device.");
          return;
        }

        // A successful intake response acknowledges the server's durable Queue.
        // Commit cleanup before starting chat: a reload must not dispatch this
        // share a second time. Server-owned post-upload completion is #1764.
        await shareReviewPartition(root).write([{ delete: `${SHARE_REVIEW_PREFIX}${record.id}` }]);
        if (signal.aborted) return;
        remove(record.id);
        dropShareClaim(record.id);
        session.owners.get(record.id)?.();
        session.owners.delete(record.id);

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
          shareId: outcome.result.id,
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

      } catch (err) {
        if (!signal.aborted) setError(err instanceof Error ? err.message : "Could not complete shared content intake");
      } finally {
        detach();
        if (session.activeUpload?.controller === controller) session.activeUpload = null;
        if (!session.controller.signal.aborted) {
          setBusy(false);
          if (session.waiting || session.pending.size) root.stores.share.getState().setPhase("paused");
        }
      }
    },
    [remove, setBusy, setError, setNotes, root, canUpload]
  );

  // Only a share the reader already confirmed may resume automatically.
  useEffect(() => {
    const connectionChanged = () => {
      const session = reviewSession.current;
      if (!session || session.controller.signal.aborted) return;
      const online = root.stores.connection.getState().wsStatus === "connected" && navigator.onLine !== false;
      const active = session.activeUpload;
      if (!online && active) {
        session.waiting = active.record;
        active.controller.abort();
        setError("Waiting for connection. Your confirmed share will resume automatically.");
      }
      const record = session.waiting ?? root.stores.share.getState().queue.find(item => session.pending.has(item.id));
      if (online && record && !root.stores.share.getState().busy && root.stores.share.getState().queue.some(item => item.id === record.id)) void confirm(record);
    };
    connectionChanged();
    window.addEventListener("online", connectionChanged);
    window.addEventListener("offline", connectionChanged);
    return () => { window.removeEventListener("online", connectionChanged); window.removeEventListener("offline", connectionChanged); };
  }, [root, wsStatus, busy, queue, confirm, setError]);

  const dismiss = useCallback(
    (record: StoredShare) => {
      const session = reviewSession.current;
      if (!session || !session.owners.has(record.id)) return;
      session.pending.delete(record.id);
      if (session.waiting?.id === record.id) session.waiting = null;
      if (session.activeUpload?.record.id === record.id) session.activeUpload.controller.abort();
      void (async () => {
        try {
          await shareReviewPartition(root).write([{ delete: `${SHARE_REVIEW_PREFIX}${record.id}` }]);
          remove(record.id);
          dropShareClaim(record.id);
          session.owners.get(record.id)?.();
          session.owners.delete(record.id);
          setError(null);
        } catch (err) { setError(err instanceof Error ? err.message : "Could not dismiss this share. The original is kept."); }
      })();
    },
    [root, remove, setError]
  );

  return { confirm, dismiss };
}
