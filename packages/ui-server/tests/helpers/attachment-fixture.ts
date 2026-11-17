import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_DIR, type AttachmentFile } from "@schlessera/brain-ui-sdk/protocol";
import { detectKind } from "../../src/attachments/detect";
import { attachmentPath } from "../../src/attachments/store";
import type { DraftStore } from "../../src/drafts/store";

/**
 * Store one original exactly as the upload route does: publish the bytes under
 * the attachment root, then reserve and commit its record. For store-level
 * tests that need real files without an HTTP round trip.
 */
export function storeOriginal(brainPath: string, store: DraftStore, principalId: string, draftId: string, name: string, body: Uint8Array | string, key = `${draftId}:${name}`): AttachmentFile {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const fileId = crypto.randomUUID();
  const path = attachmentPath(fileId, name);
  const detected = detectKind(bytes, { name, mediaType: "application/octet-stream", path });
  const dir = join(brainPath, ATTACHMENT_DIR, fileId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
  chmodSync(join(dir, name), 0o444);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { reservationId } = store.reserveAttachment(principalId, draftId, { bytes: bytes.byteLength, instanceId: "test" });
  return store.commitAttachment(principalId, draftId, {
    reservationId, idempotencyKey: key.replace(/[^A-Za-z0-9._:-]/g, "-"), fingerprint: sha256,
    file: {
      fileId, sha256, bytes: bytes.byteLength, storedName: name, incomingName: null, mediaType: detected.mediaType ?? "application/octet-stream",
      kind: detected.kind, reader: detected.reader, trackRejected: detected.trackRejected === true,
      track: detected.track ? { name, path, mediaType: detected.mediaType!, bytes: bytes.byteLength, sha256, ...detected.track.meta } : null,
    },
  }).file;
}
