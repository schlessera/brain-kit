import { useMaskStore } from "../../stores/mask-store.js";
import type { ServerMessageHandlerMap } from "./types.js";

type MaskFrame = "mask_request";

export const maskFrameHandlers = {
  mask_request: (msg) => {
    // Opens the editor; the answer travels back from the component, because
    // only the user can say which part of the picture they meant.
    useMaskStore.getState().open({
      requestId: msg.requestId,
      imagePath: msg.imagePath,
      ...(msg.instruction ? { instruction: msg.instruction } : {}),
      ...(msg.turnId ? { turnId: msg.turnId } : {}),
    });
  },
} satisfies ServerMessageHandlerMap<MaskFrame>;
