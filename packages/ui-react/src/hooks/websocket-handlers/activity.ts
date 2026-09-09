import { useActivityStore } from "../../stores/activity-store.js";
import type { ServerMessageHandlerMap } from "./types.js";

type ActivityFrame = "activity_snapshot" | "activity_delta";

export const activityFrameHandlers = {
  activity_snapshot: (msg) => {
    useActivityStore.getState().applySnapshot(msg);
  },
  activity_delta: (msg) => {
    useActivityStore.getState().applyDelta(msg);
  },
} satisfies ServerMessageHandlerMap<ActivityFrame>;
