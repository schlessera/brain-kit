import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { activityFrameHandlers } from "./activity.js";
import { chatFrameHandlers } from "./chat.js";
import { connectionFrameHandlers } from "./connection.js";
import { maskFrameHandlers } from "./mask.js";
import { providerFrameHandlers } from "./provider.js";
import type {
  DispatchContext,
  ServerMessageHandlerMap,
  ServerMessageType,
} from "./types.js";

type HandlerKeys<T> = T extends unknown ? keyof T : never;
type ClaimedFrame = HandlerKeys<
  | typeof chatFrameHandlers
  | typeof activityFrameHandlers
  | typeof maskFrameHandlers
  | typeof providerFrameHandlers
  | typeof connectionFrameHandlers
>;
type DuplicateFrame =
  | Extract<
      keyof typeof chatFrameHandlers,
      | keyof typeof activityFrameHandlers
      | keyof typeof maskFrameHandlers
      | keyof typeof providerFrameHandlers
      | keyof typeof connectionFrameHandlers
    >
  | Extract<
      keyof typeof activityFrameHandlers,
      | keyof typeof maskFrameHandlers
      | keyof typeof providerFrameHandlers
      | keyof typeof connectionFrameHandlers
    >
  | Extract<
      keyof typeof maskFrameHandlers,
      keyof typeof providerFrameHandlers | keyof typeof connectionFrameHandlers
    >
  | Extract<keyof typeof providerFrameHandlers, keyof typeof connectionFrameHandlers>;

type Assert<T extends true> = T;
type Equal<A, B> = [A, B] extends [B, A] ? true : false;
type _EveryFrameClaimed = Assert<Equal<ClaimedFrame, ServerMessageType>>;
type _NoFrameClaimedTwice = Assert<Equal<DuplicateFrame, never>>;

const serverMessageHandlers = {
  ...chatFrameHandlers,
  ...activityFrameHandlers,
  ...maskFrameHandlers,
  ...providerFrameHandlers,
  ...connectionFrameHandlers,
} satisfies ServerMessageHandlerMap<ServerMessageType>;

export function dispatchServerMessage(msg: ServerMessage, context: DispatchContext): void {
  // The mapped type preserves the message/handler correlation. TypeScript
  // loses that correlation at an indexed union access, so restore it only at
  // this single composition boundary.
  serverMessageHandlers[msg.type](msg as never, context);
}
