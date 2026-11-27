import type { StatusIndicatorFact, StatusIndicatorState } from "@schlessera/brain-ui-kit";
import type { ComposerDraft, DraftStoreState } from "../stores/draft-state.js";
import { draftFiles } from "../stores/draft-state.js";
import { queuedPending, type QueuedFile } from "./attachment-queue.js";
import { trackBytes } from "./track-uploads.js";
import { formatBytes } from "./format-bytes.js";
import { clockTime } from "./format-time.js";

/**
 * The composer's draft indicator (#3155, design brief rev 4 §1): one compact
 * state for the draft this view shows, derived from what the host
 * acknowledged and what this tab still holds. It replaces D52's persistent
 * save line, not the facts behind it.
 *
 * `success` means one thing only: the host acknowledged this exact edit
 * generation, with every original-file binding, and nothing of it waits in
 * an upload queue. An acknowledgement of an older edit is never success.
 */
type DraftIndicatorKey =
  /** Absent: no draft, or an empty one. The slot stays reserved. */
  | "none"
  | "saved"
  | "saving"
  | "queued"
  | "offline"
  /** The last save's answer was lost: the host may hold it. Check again reads. */
  | "unconfirmed"
  /** Not saved yet, for a reason no other key names (a transient refusal, no hello yet). */
  | "unsaved"
  | "upload_failed"
  | "upload_unconfirmed"
  | "upload_refused"
  | "detached"
  | "too_large"
  | "full"
  /** The brain refused this edit and would again (#4566): not sent again until it changes. */
  | "refused"
  | "unavailable"
  | "conflict"
  | "device_conflict";

/** A detail action the view renders. Each is the reader's choice; opening details runs none. */
type DraftIndicatorAction = "check" | "storage" | "compare" | "other_version";

export type DraftIndicatorView =
  | { key: "none" }
  | {
    key: Exclude<DraftIndicatorKey, "none">;
    state: StatusIndicatorState;
    /** The state in the consumer's words; also the operation's label in details. */
    stateLabel: string;
    /** One sentence: the tooltip and the top of details. */
    summary: string;
    explanation?: string;
    facts: StatusIndicatorFact[];
    action?: DraftIndicatorAction;
  };

/** Why Open other version did not open it (#4567), in the indicator's words. */
const VERSION_SWITCH_COPY = {
  cancelled: "Other version not opened: you moved away first",
  failed: "Couldn't open the other version",
  missing: "The other version isn't on this device any more",
  chat_gone: "The other version's chat is gone; its unsent messages stay there",
} as const;

export interface DraftIndicatorInput {
  draft: ComposerDraft | undefined;
  store: Pick<DraftStoreState, "supported" | "limits">;
  /** This view's own upload queue: items Send moved into a held snapshot are not the draft's. */
  queued: readonly QueuedFile[];
  /** The socket is connected and the browser says it is online. */
  online: boolean;
  /** A failed device write (#1014) takes back the claim that text is kept on this device. */
  localFailed?: boolean;
  /** Formats a timestamp as the reader's clock; injectable for tests. */
  clock?: (ms: number) => string;
  /** How the last Open other version from this draft ended, when it did not open it (#4567). */
  switchNote?: keyof typeof VERSION_SWITCH_COPY | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The host acknowledged this exact edit, every original bound and none still uploading. */
export function draftAcknowledged(d: ComposerDraft | undefined, queued: readonly QueuedFile[]): boolean {
  if (!d || d.conflict || !d.host || d.host.edit !== d.edit) return false;
  if (queued.length > 0) return false;
  const files = draftFiles(d);
  // A file carried from another draft id is not bound by this one.
  if (files.some((f) => f.lineage !== d.draftId)) return false;
  // The revision's bindings are exactly this draft's originals, in order.
  const bound = d.host.fileIds ?? [];
  return bound.length === files.length && files.every((f, i) => bound[i] === f.file.fileId);
}

/**
 * What the indicator shows for one draft, in the rev 4 §1 order of
 * precedence: another version waiting first, then refusals and failures,
 * then what is not saved yet, and success only last.
 */
export function draftIndicatorView(input: DraftIndicatorInput): DraftIndicatorView {
  const { draft: d, store, online } = input;
  const clock = input.clock ?? clockTime;
  const kept = input.localFailed ? "" : " Your text is kept in this tab.";
  const own = input.queued;
  const files = draftFiles(d);

  const note = input.switchNote ? VERSION_SWITCH_COPY[input.switchNote] : null;
  // A branch's refused save is said beside the other version, not hidden by it (#4566).
  const refusedHere = d?.failure?.kind === "refused" && d.failure.edit === d.edit ? d.failure.reason : null;
  if (d?.deviceConflict && !d.conflict && !input.localFailed) {
    return { key: "device_conflict", state: refusedHere ? "refused" : "attention", stateLabel: "Another tab changed this draft",
      summary: `Another tab changed this draft. Both versions are kept.${refusedHere ? " This one isn't saved: the brain refused it." : ""}${note ? ` ${note}.` : ""}`,
      facts: [...(refusedHere ? [{ key: "Brain said", value: refusedHere }] : []), ...(note ? [{ key: "Other version", value: note }] : [])], action: "other_version" };
  }
  // A failed device write takes back "both versions are kept", not the switch's outcome (#4567).
  if (d?.deviceConflict && !d.conflict && note) {
    return { key: "device_conflict", state: "attention", stateLabel: note, summary: `${note}.`,
      facts: [{ key: "Other version", value: note }], action: "other_version" };
  }
  // Shown even over an emptied composer: the other version still waits.
  if (d?.conflict) {
    return { key: "conflict", state: "attention", stateLabel: "Draft changed on another device",
      summary: `Draft changed on another device. Compare to choose which to keep.${note ? ` ${note}.` : ""}`,
      facts: [{ key: "This device", value: `edited ${clock(d.editedAt)}` }, { key: "Other device", value: `edited ${clock(d.conflict.other.updatedAt)}` },
        ...(note ? [{ key: "Other version", value: note }] : [])],
      action: "compare" };
  }
  // Shown even over an emptied composer: a Send's refused snapshot list is this draft's too (#4566).
  if (d?.failure?.kind === "refused" && d.failure.edit === d.edit) {
    return { key: "refused", state: "refused", stateLabel: "Draft not saved: the brain refused it",
      summary: `Draft not saved: the brain refused it.${kept}`,
      explanation: "This tab stopped sending it. Change the draft to try again.",
      facts: [{ key: "Brain said", value: d.failure.reason }] };
  }
  const content = !!d && (d.text.length > 0 || d.attachments.length > 0 || files.length > 0);
  if (!content && own.length === 0) return { key: "none" };

  if (store.supported === false) {
    return { key: "unavailable", state: "attention", stateLabel: "Not saved: this host doesn't keep drafts",
      summary: `Not saved: this host doesn't keep drafts.${input.localFailed ? "" : " Your text is kept on this device."}`, facts: [] };
  }

  // Uploads that ended without a stored file: the draft can't be saved with them.
  const refused = own.filter((item) => item.state === "refused");
  if (refused.length > 0) {
    const space = refused.some((item) => item.refusal === "space");
    const facts: StatusIndicatorFact[] = refused.map((item) => ({ key: "Not stored", value: `${item.name}, ${trackBytes(item.file.size)}` }));
    if (space) facts.push({ key: "Space", value: "attachment space full" });
    return { key: "upload_refused", state: "refused",
      stateLabel: space ? "Draft not saved: attachment space is full" : `Draft not saved: ${plural(refused.length, "file", "files")} refused`,
      summary: space ? "Draft not saved: attachment space is full." : `Draft not saved: ${plural(refused.length, "file wasn't", "files weren't")} stored.`,
      explanation: space ? `The brain refused to keep this draft's files. Nothing was removed to make room.${kept}` : undefined,
      facts, ...(space ? { action: "storage" as const } : {}) };
  }
  const failed = own.filter((item) => item.state === "failed");
  if (failed.length > 0) {
    return { key: "upload_failed", state: "failed", stateLabel: `Draft not saved: ${plural(failed.length, "file wasn't", "files weren't")} stored`,
      summary: `Draft not saved: ${plural(failed.length, "file wasn't", "files weren't")} stored.`,
      facts: failed.map((item) => ({ key: "Not stored", value: item.name })) };
  }
  if (d?.failure?.kind === "too_large") {
    const limit = d.failure.bound === "imageCount" ? `${d.failure.limit} images` : formatBytes(d.failure.limit);
    return { key: "too_large", state: "refused", stateLabel: "Draft too large to save",
      summary: `Draft not saved: too large to save (${limit} max).${input.localFailed ? "" : " Your text is kept on this device."}`, facts: [{ key: "Limit", value: limit }] };
  }
  if (d?.failure?.kind === "full") {
    const held = d.failure.bound === "drafts" ? `${d.failure.limit} drafts` : `${formatBytes(d.failure.limit)} of drafts`;
    return { key: "full", state: "refused", stateLabel: "Draft not saved: the host is full",
      summary: `Draft not saved: ${held} saved. Delete one to save this.`, facts: [{ key: "Saved", value: held }] };
  }
  const unconfirmedUploads = own.filter((item) => item.state === "unknown");
  if (unconfirmedUploads.length > 0 && online) {
    return { key: "upload_unconfirmed", state: "unknown", stateLabel: `Not saved yet: ${plural(unconfirmedUploads.length, "upload", "uploads")} unconfirmed`,
      summary: `Not saved yet: ${plural(unconfirmedUploads.length, "upload", "uploads")} unconfirmed.`,
      facts: unconfirmedUploads.map((item) => ({ key: "Unconfirmed", value: item.name })) };
  }
  const lastSaved = d?.host ? clock(d.host.updatedAt) : "never";
  if (!online && !draftAcknowledged(d, own)) {
    return { key: "offline", state: "attention", stateLabel: "Not saved: offline",
      summary: `Not saved: offline.${kept}`, facts: [{ key: "Last saved", value: lastSaved }] };
  }
  const uploading = own.filter(queuedPending);
  if (uploading.length > 0) {
    const first = uploading[0]!.name;
    const names = uploading.length === 1 ? `${first} is` : `${first} and ${plural(uploading.length - 1, "other file", "other files")} are`;
    return { key: "queued", state: "queued", stateLabel: "Not saved yet: files still uploading",
      summary: `Not saved yet: ${names} still uploading.${kept}`,
      facts: [{ key: "Waiting for", value: uploading.map((item) => item.name).join(", ") }] };
  }
  if (d && files.some((f) => f.lineage !== d.draftId)) {
    const n = files.filter((f) => f.lineage !== d.draftId).length;
    return { key: "detached", state: "attention", stateLabel: `Not saved yet: ${plural(n, "file isn't", "files aren't")} attached`,
      summary: `Not saved yet: ${plural(n, "file isn't", "files aren't")} attached to this draft. Remove or choose ${n === 1 ? "it" : "them"} again.`,
      facts: files.filter((f) => f.lineage !== d.draftId).map((f) => ({ key: "Not attached", value: f.file.incomingName || f.file.name })) };
  }
  if (d && draftAcknowledged(d, own)) {
    const n = files.length + d.attachments.length;
    const what = d.text.length > 0 ? (n > 0 ? `this text and ${plural(n, "file", "files")}` : "this text") : plural(n, "file", "files");
    const at = clock(d.host!.updatedAt);
    return { key: "saved", state: "success", stateLabel: "Draft saved",
      summary: `Draft saved ${at}: ${what}.`, facts: [{ key: "Saved", value: `${at} · revision with ${plural(n, "file", "files")}` }] };
  }
  // A save is out, or this change is about to go: nothing is claimed until the host answers.
  if (d && d.savingSince !== null) return { key: "saving", state: "active", stateLabel: "Saving draft…", summary: "Saving draft…", facts: [] };
  if (d?.failure?.kind === "unsaved" && d.failure.lost) {
    const facts: StatusIndicatorFact[] = [
      { key: "Confirmed", value: d.host ? `${clock(d.host.updatedAt)} · earlier revision` : "never" },
      { key: "This tab", value: `edited ${clock(d.editedAt)}` },
    ];
    return { key: "unconfirmed", state: "unknown", stateLabel: "Couldn't confirm the draft was saved",
      summary: "Couldn't confirm the draft was saved.",
      explanation: `The brain didn't answer after your last change.${kept} Check again asks the brain; it doesn't save again.`,
      facts, action: "check" };
  }
  if (d?.failure?.kind === "unsaved" || store.supported === null || d?.deviceOnly) {
    return { key: "unsaved", state: "attention", stateLabel: "Draft not saved yet",
      summary: `Draft not saved yet.${kept}`, facts: [{ key: "Last saved", value: lastSaved }] };
  }
  return { key: "saving", state: "active", stateLabel: "Saving draft…", summary: "Saving draft…", facts: [] };
}

