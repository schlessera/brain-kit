import { IMAGE_MARKUP_CAPABILITY } from "@schlessera/brain-ui-sdk/protocol";
import {
  BRAIN_MARKUP_MAX_BYTES,
  type BrainApplicationPolicy,
  type ImageMarkupPayload,
} from "@schlessera/brain-ui-sdk/server";
import { createMarkupApplication, MarkupRefusal, readMarkupBase, readMarkupSource } from "../../brain/markup-application.js";
import { ProviderMaskRefusedError } from "../../brain/provider-mask-refusal.js";
import { withTurnScope } from "../frames.js";
import type { MarkupSubmission } from "../turns.js";
import type { BridgeContext, BridgeSlice, MakeBridgeOptions } from "./context.js";

const NOTE = "Pass this layer to `brain image --ref <imagePath> --markup <markupPath>`, with the same image as the first --ref; never to --mask.";

/**
 * `request_image_markup` for a Claude or pi turn that may apply to the brain
 * (#3975). The whole operation is the server's: it reads the source and its
 * displayed size, asks the browser to draw, takes the layer from the turn's
 * own principal over the bounded upload route, and applies it under
 * `.brain/scratch/markup/`. The worker receives only the receipt.
 */
export function createMarkupSlice(ctx: BridgeContext, root: string, applicationPolicy: BrainApplicationPolicy,
  options: Pick<MakeBridgeOptions, "protectedPaths" | "turnData">): BridgeSlice<"requestImageMarkup"> {
  const { host, turn, turnId, principalId, signal, work, recorder, maskGuard, toolName, isAuthorized, hold, assertAuthority } = ctx;
  const { coordinator } = host;
  const { protectedPaths, turnData } = options;
  const apply = createMarkupApplication({ maintenance: host.maintenance, root, principalId, turnId, signal,
    // The scratch prune that follows a layer never removes a masked folder's files.
    protectedPaths: maskGuard ? [...(protectedPaths ?? []), ...maskGuard.folders] : protectedPaths,
    lock: applicationPolicy.lock, isAuthorized, hold, isAvailable: () => work?.posture !== "voice",
    ...(turnData ? { turnTree: turnData.tree } : {}),
    record: result => recorder?.recordApplication?.(result) });
  const refused = (code: string, message: string): never => {
    recorder?.recordApplication?.({ ok: false, code, message, changes: [] });
    throw new Error(message);
  };
  return {
    requestImageMarkup: async ({ imagePath, instruction }) => {
      assertAuthority();
      if (work?.posture === "voice") refused("membership_denied", "This turn's membership does not permit image markup.");
      try { maskGuard?.assert(toolName("request_image_markup"), [imagePath]); }
      catch (error) {
        if (error instanceof ProviderMaskRefusedError) refused(error.code, error.message);
        throw error;
      }
      let base;
      try { base = readMarkupBase(root, imagePath); }
      catch (error) {
        if (error instanceof MarkupRefusal) refused(error.code, error.message);
        throw error;
      }
      if (!host.clients.anyDeclares(IMAGE_MARKUP_CAPABILITY, principalId))
        throw new Error(`No connected ${host.appName} client of yours can show the markup editor.`);
      const requestId = coordinator.nextMarkupRequestId();
      const submission = await new Promise<MarkupSubmission>((resolve, reject) => {
        const drained = coordinator.drainedReason(turn, turnId);
        if (drained !== undefined) return reject(new Error(drained));
        if (!coordinator.openMarkup(requestId, { turn, turnId, principalId,
          source: () => readMarkupSource(root, imagePath, base.imageHash), resolve, reject })) {
          reject(new Error("Duplicate markup request id"));
          return;
        }
        // Only the turn's principal's connections that can draw see it.
        host.clients.broadcast(withTurnScope({
          type: "markup_request", requestId, imagePath, ...(instruction ? { instruction } : {}),
          width: base.width, height: base.height, maxBytes: BRAIN_MARKUP_MAX_BYTES,
          uploadPath: `/markup/${encodeURIComponent(requestId)}`,
          sourcePath: `/markup/${encodeURIComponent(requestId)}/source`,
        }, turn, turnId), undefined, IMAGE_MARKUP_CAPABILITY, principalId);
        host.sendToClients(withTurnScope(
          { type: "status", status: "tool_executing", detail: "Waiting for you to mark up the image" }, turn, turnId));
      });
      const result = await apply({ principalId, turnId, imagePath, png: submission.png, base });
      if (!result.ok || !result.outcome) throw new Error(result.message);
      const payload: ImageMarkupPayload = {
        imagePath,
        markupPath: result.outcome.markupPath,
        width: result.outcome.width,
        height: result.outcome.height,
        bytes: result.outcome.bytes,
        marks: submission.marks,
        notes: submission.notes,
        note: NOTE,
      };
      return payload;
    },
  };
}
