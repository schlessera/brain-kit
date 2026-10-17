import { createHash } from "node:crypto";
import type { PromptPrefixFingerprint } from "../protocol.js";

/** Hash immediately at assembly: raw prompt/schema values never cross activity. */
export function promptPrefixFingerprint(input: {
  tools?: unknown; system?: unknown; model?: unknown; thinking?: unknown;
  gitStatusIncluded: boolean | null;
}): PromptPrefixFingerprint {
  const hash = (value: unknown): string | null => value === undefined ? null
    : createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { tools: hash(input.tools), system: hash(input.system), model: hash(input.model),
    thinking: hash(input.thinking), gitStatusIncluded: input.gitStatusIncluded, coverage: "assembled_inputs" };
}
