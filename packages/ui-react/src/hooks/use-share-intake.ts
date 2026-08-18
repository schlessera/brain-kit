import { useCallback, useEffect } from "react";
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
import { useChatStore } from "../stores/chat-store.js";
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
import { sendClientMessage } from "./use-websocket.js";

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
          dropShareClaim(id);
          if (record && !disposed) enqueue(record);
        }

        // Orphans: a share whose landing page never ran (the app opened
        // offline on the fallback page, or the tab was closed before the
        // parameter was read) leaves a record nobody holds the id for. The
        // stash is the only place it still exists.
        for (const record of await store.list()) {
          const taken = await store.take(record.id);
          if (taken && !disposed) enqueue(taken);
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
      const share = useShareStore.getState();
      if (share.busy) return;
      if (useConnectionStore.getState().wsStatus !== "connected") {
        setError("Not connected yet — this will work as soon as the app reconnects.");
        return;
      }

      setBusy(true);
      setError(null);
      setNotes([]);
      try {
        const outcome = await uploadShare(record);
        if (!outcome.ok) {
          setError(describeUploadError(outcome));
          return;
        }

        const { attachments, errors } = await shareImagesToAttachments(record.files);
        if (errors.length) setNotes(errors);

        const prompt = buildSharePrompt(outcome.result as ShareIntakeResult);
        const chat = useChatStore.getState();
        // Always start from a fresh draft: `activeSessionId` is restored from
        // localStorage at store creation, so on a cold boot it already points
        // at whatever session was last open.
        chat.clearMessages();
        // Ownership of the preview URLs transfers to the message here — the
        // chat store revokes them. Nothing below may revoke them again.
        chat.addUserMessage(
          null,
          prompt,
          "typed",
          attachments.length
            ? attachments.map((a) => ({
                previewUrl: a.previewUrl,
                mediaType: a.attachment.mediaType,
              }))
            : undefined
        );
        chat.startAssistantMessage(null);

        const sent = sendClientMessage({
          type: "chat_message",
          text: prompt,
          ...(attachments.length
            ? { attachments: attachments.map((a) => a.attachment) }
            : {}),
          ...(detectClientEnvironment() ? { client: detectClientEnvironment() } : {}),
        });
        if (!sent) {
          setError("The connection dropped before that could be sent.");
          return;
        }

        remove(record.id);
        dropShareClaim(record.id);
      } finally {
        setBusy(false);
      }
    },
    [remove, setBusy, setError, setNotes]
  );

  const dismiss = useCallback(
    (record: StoredShare) => {
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
