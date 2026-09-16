import type { AskUserQuestion } from "../../protocol.js";
import type { AskUserInput, AskUserPayload } from "../../tool-contracts/index.js";
import type { BackendBridge } from "../backend.js";

export async function handleAskUser(
  input: AskUserInput,
  bridge: BackendBridge,
  requestId: string = crypto.randomUUID()
): Promise<AskUserPayload> {
  if (!bridge.askUser) {
    throw new Error("The host does not support ask_user in this session.");
  }
  const questions = input.questions as AskUserQuestion[];
  const response = await bridge.askUser(requestId, questions);
  return {
    questions,
    answers: response.answers,
    ...(response.annotations ? { annotations: response.annotations } : {}),
  };
}
