import { FIRST_PARTY_FAILURE_CLASSES, type TurnFailure } from "@schlessera/brain-ui-sdk/protocol";

const DENIAL_DETAILS: Readonly<Record<string, string>> = {
  safety_changed: "safety changed during admission",
  max_bytes_per_turn: "the turn's network byte limit was reached",
  call_not_admitted: "the host did not admit this connection",
  destination_not_allowed: "the destination is not allowed by the host's network policy",
  destination_port: "the destination port is not allowed",
  unresolved_destination: "the destination could not be resolved",
  private_destination: "the destination is a private address",
  metadata_destination: "the destination is a metadata address",
  outward_not_approved: "the outward connection was not approved",
  turn_cancelled: "the turn was cancelled",
  client_disconnected: "the request was cancelled",
  inference_admission_refused: "network admission was refused",
  inference_request_too_large: "the inference request exceeded the host's size limit",
};

/** Relay-owned signals, read only from a runtime error, never model prose. */
export function hostRefusal(text: string, status: number | undefined, reason?: string): TurnFailure | null {
  const fixed = /^(?:(?:Failed to authenticate\. )?API Error: [1-5]\d\d )?(?:Inference network admission refused|Inference request refused|Inference request cancelled|Inference egress limit exceeded)\.?$/;
  const body = /"type"\s*:\s*"brain_inference_refused"/.test(text);
  if (!fixed.test(text) && !body) return null;
  // Only first-party codes become prose; arbitrary host data is not disclosed.
  const detail = reason && Object.hasOwn(DENIAL_DETAILS, reason) ? DENIAL_DETAILS[reason] : undefined;
  return { errorClass: FIRST_PARTY_FAILURE_CLASSES.host_refused,
    ...(status !== undefined ? { status } : {}),
    message: `The host refused this model request${detail ? ` (${detail})` : ""}.` };
}
