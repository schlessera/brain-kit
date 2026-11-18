import type { ServerMessageHandlerMap } from "./types.js";

type MaskFrame = "mask_request" | "markup_request";

export const maskFrameHandlers = {
  mask_request: (msg, context) => {
    // Opens the editor; the answer travels back from the component, because
    // only the user can say which part of the picture they meant.
    context.stores.mask.getState().open({
      requestId: msg.requestId,
      imagePath: msg.imagePath,
      ...(msg.instruction ? { instruction: msg.instruction } : {}),
      ...(msg.turnId ? { turnId: msg.turnId } : {}),
    });
  },
  markup_request: (msg, context) => {
    // The markup editor (#3975): drawn here, uploaded by the component.
    context.stores.markup.getState().open({
      requestId: msg.requestId,
      imagePath: msg.imagePath,
      ...(msg.instruction ? { instruction: msg.instruction } : {}),
      width: msg.width,
      height: msg.height,
      maxBytes: msg.maxBytes,
      uploadPath: msg.uploadPath,
      sourcePath: msg.sourcePath,
      ...(msg.turnId ? { turnId: msg.turnId } : {}),
    });
  },
} satisfies ServerMessageHandlerMap<MaskFrame>;
