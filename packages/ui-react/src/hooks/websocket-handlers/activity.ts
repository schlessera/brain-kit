import type { ServerMessageHandlerMap } from "./types.js";

type ActivityFrame = "activity_snapshot" | "activity_delta";

export const activityFrameHandlers = {
  activity_snapshot: (msg, context) => {
    context.stores.activity.getState().applySnapshot(msg);
  },
  activity_delta: (msg, context) => {
    context.stores.activity.getState().applyDelta(msg);
  },
} satisfies ServerMessageHandlerMap<ActivityFrame>;
