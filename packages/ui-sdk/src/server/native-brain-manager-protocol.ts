/** Concrete host-only protocol. No request accepts host paths, commands, caller-selected UIDs or mount authority. */
import { z } from "zod";

export const nativeCheckpointId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const nativeManagerRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("ready") }).strict(),
  z.object({ operation: z.literal("checkpoint"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("release"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("delta"), from: nativeCheckpointId, to: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("listRecovery"), after: nativeCheckpointId.nullable() }).strict(),
  z.object({ operation: z.literal("prepareStage"), id: nativeCheckpointId, checkpointId: nativeCheckpointId, allowanceBytes: z.number().int().positive() }).strict(),
  z.object({ operation: z.literal("attestStage"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("inspectStage"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("releaseStage"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("readCheckpoint"), id: nativeCheckpointId,
    action: z.enum(["file", "stat", "list"]), path: z.string().max(4096).refine(path => !path.startsWith("/") && !path.includes("\0") &&
      (!path || path.split("/").length <= 256 && path.split("/").every(part => part && part !== "." && part !== ".."))),
    maximum: z.number().int().nonnegative(),
  }).strict(),
  z.object({ operation: z.literal("readStage"), id: nativeCheckpointId,
    action: z.enum(["file", "stat", "list"]), path: z.string().max(4096).refine(path => !path.startsWith("/") && !path.includes("\0") &&
      (!path || path.split("/").length <= 256 && path.split("/").every(part => part && part !== "." && part !== ".."))),
    maximum: z.number().int().nonnegative(),
  }).strict(),
  z.object({ operation: z.literal("cancelCheckpointRead"), id: nativeCheckpointId }).strict(),
  // Reference pool (#2428). Identities are caller-generated UUIDs; the manager
  // alone chooses paths, qgroups and limits within its configured allowance.
  z.object({ operation: z.literal("poolStatus") }).strict(),
  z.object({ operation: z.literal("poolCreate"), id: nativeCheckpointId, purpose: z.enum(["source", "worktree", "staging"]),
    from: nativeCheckpointId.nullable(), allowanceBytes: z.number().int().positive() }).strict(),
  z.object({ operation: z.literal("poolSeal"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("poolRelease"), id: nativeCheckpointId }).strict(),
  z.object({ operation: z.literal("listPoolRecovery"), after: nativeCheckpointId.nullable() }).strict(),
]);
export type NativeManagerRequest = z.infer<typeof nativeManagerRequest>;
export type NativeManagerErrorCode = "unsupported" | "capacity" | "unavailable" | "unknown" | "released" | "invalid";
export class NativeBrainManagerError extends Error {
  constructor(readonly code: NativeManagerErrorCode, message: string) { super(message); this.name = "NativeBrainManagerError"; }
}
export interface NativeCheckpoint {
  id: string;
  /** Fixed live source identity; an app lease must remain bound across service restart. */
  sourceUuid: string;
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
  kind?: "stage";
  stage?: NativeStage;
  stageRequest?: { checkpointId: string; checkpointUuid: string; allowanceBytes: number };
}
export interface NativeStage {
  id: string;
  checkpointId: string;
  checkpointUuid: string;
  sourceUuid: string;
  path: string;
  namespacePid: number;
  namespaceStart: string;
  appUid: number;
  appGid: number;
  allowanceBytes: number;
  rootDevice: string;
  rootInode: string;
}
/**
 * One reference-pool root (#2428). `reserved` and `writable` hold their whole
 * allowance; `sealed`, `deleting` and `deleted` hold measured allocation until
 * an observation proves reclamation (`reclaimed`).
 */
export type NativePoolState = "reserved" | "writable" | "sealed" | "deleting" | "deleted" | "reclaimed";
export interface NativePoolRootIdentity {
  /** Btrfs root id, UUID and creation generation; together they fence stale identities. */
  rootId: string; uuid: string; otransid: string;
}
export interface NativePoolRecord {
  id: string;
  purpose: "source" | "worktree" | "staging";
  /** Sealed pool root this one was snapshotted from, or null for an empty root. */
  from: string | null;
  allowanceBytes: number;
  state: NativePoolState;
  root: NativePoolRootIdentity | null;
  /** Host path of a live root; never accepted from a requester. */
  path: string | null;
  /** Last reconciled owner charge in bytes (simple-quota referenced plus reservations). */
  ownerBytes: number | null;
  /** Why a create ended without a root, or why deletion still awaits reclamation. */
  reason: string | null;
}
export interface NativePoolSpace { profile: "single" | "dup"; diskUsed: number; diskTotal: number; bytesUsed: number; bytesReserved: number; bytesMayUse: number; bytesPinned: number }
export interface NativePoolStatus {
  qualified: boolean;
  /** Admission refusal; status and recovery stay usable while it is set. */
  refusal: { code: "unsupported" | "capacity" | "unknown" | "changing"; message: string } | null;
  fsid: string;
  limits: { combinedBytes: number; operationBytes: number; emergencyBytes: number; physicalFloorBytes: number; maxIdentities: number };
  accounting: {
    basis: "btrfs-space-info-disk-used+simple-quota-owner";
    /** Filesystem generation and the stable double read the numbers came from. */
    observation: { generation: string; enableGeneration: string; reads: number };
    /** Unique physical allocation across data, metadata and system, profile replication included. */
    aggregateBytes: number;
    emergencyAllocatedBytes: number;
    /** aggregateBytes minus emergency allocation: the amount charged to the combined allowance. */
    chargedBytes: number;
    /** Owner-charged bytes summed across pool roots (logical, no profile replication). */
    ownerBytes: number;
    /** Physical allocation not attributed to any pool root: global trees, replication and private state. */
    globalBytes: number;
    spaces: { data: NativePoolSpace; metadata: NativePoolSpace; system: NativePoolSpace };
    /** Physical bytes still promised to reserved and writable roots, after their measured use. */
    pendingBytes: number;
    /** Physical bytes reserved per remaining owner-charged byte under the qualified profiles. */
    reservationFactor: { numerator: number; denominator: number };
    availableBytes: number;
  } | null;
  physical: {
    kind: "dedicated-device" | "sparse-loop";
    deviceBytes: number;
    backingAllocatedBytes: number | null;
    unbackedBytes: number;
    backingAvailableBytes: number | null;
    otherConsumersBytes: number | null;
    /** Backing free space left after the floor, this pool's unbacked bytes and other ledger entries. */
    headroomBytes: number | null;
  } | null;
  counts: Record<NativePoolState, number>;
  identities: number;
}
/** The privileged helper inspects only its bounded upper layer after the worker exits. */
export interface NativeStageChange { pathHex: string; kind: "entry" | "whiteout" | "opaque" }
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
