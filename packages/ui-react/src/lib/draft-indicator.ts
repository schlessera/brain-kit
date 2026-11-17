import type { StatusIndicatorFact, StatusIndicatorState } from "@schlessera/brain-ui-kit";
import type { ComposerDraft, DraftStoreState } from "../stores/draft-state.js";
import { draftFiles } from "../stores/draft-state.js";
import { queuedPending, type QueuedFile } from "./attachment-queue.js";
import { trackBytes } from "./track-uploads.js";

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
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function bytesLabel(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

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

  if (d?.deviceConflict && !d.conflict && !input.localFailed) {
    return { key: "device_conflict", state: "attention", stateLabel: "Another tab changed this draft",
      summary: "Another tab changed this draft. Both versions are kept.", facts: [], action: "other_version" };
  }
  // Shown even over an emptied composer: the other version still waits.
  if (d?.conflict) {
    return { key: "conflict", state: "attention", stateLabel: "Draft changed on another device",
      summary: "Draft changed on another device. Compare to choose which to keep.",
      facts: [{ key: "This device", value: `edited ${clock(d.editedAt)}` }, { key: "Other device", value: `edited ${clock(d.conflict.other.updatedAt)}` }],
      action: "compare" };
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
    const limit = d.failure.bound === "imageCount" ? `${d.failure.limit} images` : bytesLabel(d.failure.limit);
    return { key: "too_large", state: "refused", stateLabel: "Draft too large to save",
      summary: `Draft not saved: too large to save (${limit} max).${input.localFailed ? "" : " Your text is kept on this device."}`, facts: [{ key: "Limit", value: limit }] };
  }
  if (d?.failure?.kind === "full") {
    const held = d.failure.bound === "drafts" ? `${d.failure.limit} drafts` : `${bytesLabel(d.failure.limit)} of drafts`;
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

/** Every state except saved and absent is work a reload could lose: the leave guards hold for it. */
export const draftIndicatorAtRisk = (view: DraftIndicatorView): boolean => view.key !== "none" && view.key !== "saved";
