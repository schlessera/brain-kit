/** Content identity shared by font verification and capture provenance. */
import { createHash } from "node:crypto";
export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
