/** Concrete host-only protocol. No request accepts paths, commands or mount authority. */
import { z } from "zod";

export const nativeCheckpointId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const nativeManagerRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("ready") }).strict(),
  z.object({ operation: z.literal("checkpoint"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("release"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("delta"), from: nativeCheckpointId, to: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("listRecovery"), after: nativeCheckpointId.nullable() }).strict(),
]);
export type NativeManagerRequest = z.infer<typeof nativeManagerRequest>;
export type NativeManagerErrorCode = "unsupported" | "capacity" | "unavailable" | "unknown" | "released" | "invalid";
export class NativeBrainManagerError extends Error {
  constructor(readonly code: NativeManagerErrorCode, message: string) { super(message); this.name = "NativeBrainManagerError"; }
}
export interface NativeCheckpoint {
  id: string;
  /** Host-created sealed root; never supplied by the requester. */
  path: string;
  fsid: string;
  rootId: string;
  /** Raw lowercase UUID as used by the native send parser. */
  uuid: string;
  /** Actual BTRFS_IOC_GET_SUBVOL_INFO ctransid, not otransid/"Gen at creation". */
  transaction: string;
  readOnly: true;
}
export interface NativeManagerReady {
  brainPath: string;
  brainUuid: string;
  brainRootId: string;
  /** Mandatory worker masks. A read-only bind does not prevent Unix socket connection. */
  privatePaths: string[];
  fsid: string;
  capacityBytes: number;
  availableBytes: number;
  recoveryReserveBytes: number;
  reserveAllocatedBytes: number;
}
export interface NativeRecoveryRecord {
  id: string;
  state: "creating" | "sealed" | "deleting" | "deleted";
  checkpoint?: NativeCheckpoint;
}
export const NATIVE_CONTROL_BYTES = 64 * 1024;
export const NATIVE_DATA_CHUNK_BYTES = 64 * 1024;
/** Transport work bounds, configurable; neither is a history/object/change quota. */
export const NATIVE_MANAGER_OPERATION_TIMEOUT_MS = 30_000;
export const NATIVE_MANAGER_MAX_DELTA_BYTES = 64 * 1024 * 1024;
/** Five-byte header: type (data=1, completion=2), unsigned big-endian payload length. */
export function nativeManagerFrame(type: 1 | 2, bytes: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + bytes.byteLength);
  frame[0] = type; new DataView(frame.buffer).setUint32(1, bytes.byteLength); frame.set(bytes, 5);
  return frame;
}
