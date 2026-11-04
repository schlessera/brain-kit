import { parseImportedTrack } from "@schlessera/brain-geo";
import { ATTACHMENT_DIR, type TrackFileView } from "@schlessera/brain-ui-sdk/protocol";
import type { AwaitableDraftStore } from "../drafts/store.js";
import { readVerified } from "./files.js";
import { attachmentPath, FILE_ID, toAttachmentFile } from "./store.js";

/**
 * Read a validated track stored as a composer original (#3153), for the
 * track view (`show_block kind=track`). Only a recorded `track` file still
 * referenced somewhere, read back with its digest verified, and reparsed by
 * the same shared parser: a client never supplies trusted coordinates.
 */
export async function readAttachmentTrack(brainRoot: string, store: Pick<AwaitableDraftStore, "attachments" | "attachmentReferenced">, path: string): Promise<TrackFileView> {
  const match = new RegExp(`^${ATTACHMENT_DIR.replace(/[.]/g, "\\.")}/([a-f0-9-]{36})/[^/]+$`).exec(path);
  const fileId = match?.[1];
  if (!fileId || !FILE_ID.test(fileId)) throw Error("Expected an attachment reference.");
  const row = store.attachments([fileId]).get(fileId);
  if (!row || row.state !== "stored" || row.kind !== "track" || attachmentPath(row.file_id, row.stored_name) !== path || !store.attachmentReferenced(fileId)) {
    throw Error("No referenced track is stored at this path.");
  }
  const file = toAttachmentFile(row);
  if (!file.track) throw Error("The track record is incomplete.");
  const read = await readVerified(brainRoot, row);
  if (!read.ok) throw Error("The track original is unavailable or changed.");
  const imported = parseImportedTrack(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
  return { ...imported, file: file.track };
}
