import {
  askUserFormSpec,
  askUserFormPayload,
  type AskUserFormInput,
  type AskUserFormPayload,
} from "../../tool-contracts/form.js";
import type { BackendBridge } from "../backend.js";

/**
 * Run `ask_user_form` through the host bridge within the host's form limits.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export async function handleAskUserForm(
  input: AskUserFormInput,
  bridge: BackendBridge,
  requestId: string = crypto.randomUUID(),
): Promise<AskUserFormPayload> {
  if (!bridge.askUserForm)
    throw new Error("The host does not support ask_user_form in this session.");
  const spec = askUserFormSpec(input, bridge.askUserFormLimits);
  return askUserFormPayload(spec, await bridge.askUserForm(requestId, spec));
}
