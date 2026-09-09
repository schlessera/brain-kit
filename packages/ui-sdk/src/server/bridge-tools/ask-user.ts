import { z } from "zod";

import type { AskUserAnnotation, AskUserQuestion } from "../../protocol.js";
import type { BackendBridge } from "../backend.js";

export const ASK_USER_TOOL_NAME = "ask_user";

export const ASK_USER_DESCRIPTION = [
  "Ask the user 1-4 multiple-choice questions when you need information you cannot reasonably infer.",
  "Use this BEFORE finalizing a plan or implementing an ambiguous request — it is the headless replacement for the AskUserQuestion built-in tool.",
  "Each question gets a short chip header, the full question text, and 2-4 mutually exclusive options (or non-exclusive when multiSelect=true). The UI auto-adds an Other option that lets the user supply free-text, so never include an Other option yourself.",
  "Prefer one focused question over many; only batch when the answers are genuinely independent. Do not use this for permission prompts — those go through the existing tool-approval flow.",
].join("\n");

const optionSchema = z.object({
  label: z.string().describe("Display text for this option (1-5 words)."),
  description: z
    .string()
    .describe(
      "Explanation of what this option means or the implication of choosing it."
    ),
  preview: z
    .string()
    .optional()
    .describe(
      "Optional preview content rendered when this option is focused. Markdown — code blocks, ASCII mockups, comparison tables."
    ),
});

const questionSchema = z.object({
  question: z
    .string()
    .describe(
      "The complete question to ask. Specific, ends with a question mark. Phrase it for multi-select when applicable."
    ),
  header: z
    .string()
    .max(12)
    .describe('Short chip label, max 12 chars (e.g. "Library").'),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe(
      'Choices for this question — 2 to 4 items. The user can always pick "Other" and provide free-text; do not include an Other option yourself.'
    ),
  multiSelect: z
    .boolean()
    .describe(
      "True if the user can pick several options. False for mutually exclusive choices."
    ),
});

export const ASK_USER_INPUT_SCHEMA = z.object({
  questions: z.array(questionSchema).min(1).max(4),
});

export type AskUserInput = z.infer<typeof ASK_USER_INPUT_SCHEMA>;

export interface AskUserPayload {
  questions: AskUserQuestion[];
  answers: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
}

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
