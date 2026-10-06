/**
 * What a card says about its submitted answer: the approved design's §3
 * table, word for word (#910). Changing a string here changes reviewed copy.
 */
import { MAX_QUEUED_ANSWERS, type AnswerDelivery } from "./types.js";

export type DeliveryAction = "cancel" | "copy" | "sendAsMessage" | "edit" | "reload" | "tryAgain";

export interface DeliveryCopy {
  tag: string;
  body?: string;
  meta?: string;
  actions: DeliveryAction[];
  /** Announced to assistive technology when the card enters this state. */
  announce: boolean;
}

/** The line under `Send as message` (ruling R1). */
export const SEND_AS_MESSAGE_NOTE = "Sends a new chat message; it doesn't answer this question.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "09:41", in local time. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2 Oct 09:41", in local time. */
export function dayAndTime(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clockTime(at)}`;
}

function closedMeta(delivery: AnswerDelivery): string {
  const at = clockTime(delivery.settledAt ?? delivery.submittedAt);
  switch (delivery.reason) {
    case "not_recognized":
      return "not recognized by the host";
    case "cancelled":
      return `question dismissed ${at} · nothing was sent`;
    case "answered_elsewhere":
      return `answered elsewhere ${at} · this answer was not used`;
    case "refused":
      return `not accepted by the host ${at} · nothing was sent`;
    default:
      return `turn ended ${at} · nothing was sent`;
  }
}

export function deliveryCopy(delivery: AnswerDelivery): DeliveryCopy {
  switch (delivery.state) {
    case "saving":
      return { tag: "SAVING…", actions: [], announce: false };
    case "queued":
      return {
        tag: "NOT SENT YET · SAVED ON THIS DEVICE",
        body: "You're offline. Your answer sends automatically when you're back.",
        meta: `queued ${clockTime(delivery.submittedAt)} · stops after 24 h`,
        actions: ["cancel"],
        announce: true,
      };
    case "awaiting":
      return {
        tag: "SENT · WAITING FOR THE HOST",
        body: "Your answer was sent. Waiting for the host to confirm it got it.",
        meta: "checking again in 5 s if no reply",
        actions: [],
        announce: true,
      };
    case "answered":
      return {
        tag: "ANSWERED",
        body: "The host received your answer.",
        meta: `confirmed ${clockTime(delivery.settledAt ?? delivery.submittedAt)}`,
        actions: [],
        announce: true,
      };
    case "closed":
      return {
        tag: "NOT DELIVERED · QUESTION CLOSED",
        body: "This question ended before your answer arrived. Your answer is kept below.",
        meta: closedMeta(delivery),
        actions: ["copy", "sendAsMessage"],
        announce: true,
      };
    case "expired":
      return {
        tag: "NOT SENT · STOPPED TRYING",
        body: "This answer waited more than 24 hours and wasn't sent.",
        meta: `queued ${dayAndTime(delivery.submittedAt)}`,
        actions: ["copy", "sendAsMessage"],
        announce: false,
      };
    case "cancelled":
      return {
        tag: "NOT SENT · CANCELLED",
        body: "You stopped this answer before it was sent.",
        actions: delivery.editable ? ["edit"] : [],
        announce: false,
      };
    case "update":
      return {
        tag: "CAN'T SEND · UPDATE NEEDED",
        body: "This app or the host is too old to confirm answers. Your answer is kept.",
        meta: "answers need receipt support",
        actions: ["reload"],
        announce: true,
      };
    case "full":
      return {
        tag: "CAN'T SAVE MORE ANSWERS",
        body:
          delivery.full === "bytes"
            ? "16 MB of answers are already waiting to send. This one stays here, unsent."
            : `${MAX_QUEUED_ANSWERS} answers are already waiting to send. This one stays here, unsent.`,
        meta:
          delivery.full === "bytes"
            ? "16 MB queued · nothing dropped"
            : `${MAX_QUEUED_ANSWERS} / ${MAX_QUEUED_ANSWERS} queued · nothing dropped`,
        actions: ["tryAgain"],
        announce: true,
      };
    case "notSaved":
      return {
        tag: "NOT SAVED ON THIS DEVICE",
        body: "This device couldn't save your answer, so it can't send it later. Stay online and try again.",
        actions: ["tryAgain"],
        announce: false,
      };
    case "signedOut":
      return {
        tag: "NOT SENT · SIGNED OUT",
        body: "You signed out before this answer was confirmed. Your answer is kept.",
        actions: ["copy"],
        announce: false,
      };
  }
}
