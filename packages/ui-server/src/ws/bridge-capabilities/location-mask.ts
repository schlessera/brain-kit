import type { BrainApplicationPolicy, LocationFix } from "@schlessera/brain-ui-sdk/server";
import { createMaskApplication, readMaskBase, type MaskBase } from "../../brain/mask-application.js";
import { ProviderMaskRefusedError } from "../../brain/provider-mask-refusal.js";
import { withTurnScope } from "../frames.js";
import type { BridgeContext, BridgeSlice, MakeBridgeOptions } from "./context.js";

/** Requests the browser answers itself: a location fix and a painted mask. */
export function createLocationAndMask(ctx: BridgeContext): BridgeSlice<"getLocation" | "requestMask"> {
  const { host, turn, turnId } = ctx;
  const { coordinator } = host;
  return {
    getLocation: (options) => {
      if (!host.clients.hasClients()) {
        return Promise.reject(
          new Error(`No ${host.appName} client is connected to read the location from.`)
        );
      }
      const requestId = coordinator.nextLocationRequestId();
      return new Promise<LocationFix>((resolve, reject) => {
        const drained = coordinator.drainedReason(turn, turnId);
        if (drained !== undefined) return reject(new Error(drained));
        if (!coordinator.openLocation(requestId, { turn, turnId, resolve, reject })) {
          reject(new Error("Duplicate location request id"));
          return;
        }
        host.sendToClients(
          withTurnScope({ type: "location_request", requestId, options }, turn, turnId)
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: "Requesting your location" },
            turn,
            turnId
          )
        );
      });
    },
    requestMask: (imagePath, instruction) => {
      if (!host.clients.hasClients()) {
        return Promise.reject(
          new Error(`No ${host.appName} client is connected to paint a mask in.`)
        );
      }
      const requestId = coordinator.nextMaskRequestId();
      return new Promise<Uint8Array>((resolve, reject) => {
        const drained = coordinator.drainedReason(turn, turnId);
        if (drained !== undefined) return reject(new Error(drained));
        if (!coordinator.openMask(requestId, { turn, turnId, resolve, reject })) {
          reject(new Error("Duplicate mask request id"));
          return;
        }
        host.sendToClients(
          withTurnScope({ type: "mask_request", requestId, imagePath, instruction }, turn, turnId)
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: "Waiting for you to mark the area" },
            turn,
            turnId
          )
        );
      });
    },
  };
}

/**
 * Mask application for a Claude or pi turn that may apply to the brain: the
 * browser's mask request is kept as this turn's pending submission, and only
 * that exact submission may be applied. Wraps `requestMask`, the slice
 * `createLocationAndMask` returned.
 */
export function createMaskApplicationSlice(ctx: BridgeContext, root: string, applicationPolicy: BrainApplicationPolicy,
  requestMask: NonNullable<BridgeSlice<"requestMask">["requestMask"]>, options: Pick<MakeBridgeOptions, "protectedPaths" | "turnData">): BridgeSlice<"requestMask" | "applyImageMask"> {
  const { host, turnId, principalId, signal, work, backendId, recorder, maskGuard, toolName, isAuthorized, hold, afterHolds, assertAuthority, principalIsAuthorized } = ctx;
  const { protectedPaths, turnData } = options;
  // Composed only for a Claude or pi turn.
  const backend = backendId as "claude" | "pi";
  const pendingMasks = new Map<string, { base: MaskBase; png: Uint8Array }>();
  // The scratch prune that follows a mask never removes a masked folder's files.
  const applyMask = createMaskApplication({ maintenance: host.maintenance, root, backend, principalId, turnId, signal,
    protectedPaths: maskGuard ? [...(protectedPaths ?? []), ...maskGuard.folders] : protectedPaths,
    lock: applicationPolicy.lock, isAuthorized, hold, isAvailable: () => work?.posture !== "voice",
    ...(turnData ? { turnTree: turnData.tree } : {}),
    record: result => recorder?.recordApplication?.(result) });
  return {
    requestMask: async (imagePath, instruction) => {
      assertAuthority();
      maskGuard?.assert(toolName("request_image_mask"), [imagePath]);
      const base = readMaskBase(root, imagePath, backend);
      const png = await requestMask(imagePath, instruction);
      await afterHolds(() => { assertAuthority(); pendingMasks.set(imagePath, { base, png: Uint8Array.from(png) }); });
      return png;
    },
    // The mask application waits for holds itself, so its refusals are recorded.
    applyImageMask: input => afterHolds(() => {
      if (signal.aborted || !principalIsAuthorized()) throw new Error("This turn no longer has current principal authority.");
      try { maskGuard?.assert(toolName("request_image_mask"), [input.imagePath, input.maskPath]); }
      catch (error) {
        if (!(error instanceof ProviderMaskRefusedError)) throw error;
        const result = { ok: false, code: error.code, message: error.message, changes: [] };
        recorder?.recordApplication?.(result); return result;
      }
      const pending = pendingMasks.get(input.imagePath);
      pendingMasks.delete(input.imagePath);
      if (!pending || !Buffer.from(pending.png).equals(Buffer.from(input.png))) {
        const result = { ok: false, code: "permission_denied", message: "No matching browser mask submission exists for this turn.", changes: [] };
        recorder?.recordApplication?.(result); return result;
      }
      return applyMask({ principalId, turnId, input, base: pending.base });
    }, false),
  };
}
