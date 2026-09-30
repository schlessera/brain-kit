/** The installed agent contract shared by the Codex and Gemini emitters. */

import { resolve } from "path";

export const CONTRACT_START = "<!-- brain-kit:contract:start -->";
export const CONTRACT_END = "<!-- brain-kit:contract:end -->";

/** `<core>/CONTRACT.md`, at the same relative depth from src/ and dist/. */
export const CONTRACT_FILE = resolve(import.meta.dir, "../../../../CONTRACT.md");

/** The installed body, with only surrounding whitespace normalized, inside managed markers. */
export function renderContractBlock(contract: string): string {
  return [
    CONTRACT_START,
    "<!-- Managed by `brain skills sync` from the installed @schlessera/brain CONTRACT.md — do not edit between these markers. -->",
    "",
    contract.replace(/^\s+|\s+$/g, ""),
    "",
    CONTRACT_END,
  ].join("\n");
}
