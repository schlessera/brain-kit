/** Report-only native assessment observation; no full research-workflow or correctness claim. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { observe } from "./brain";
import { hash } from "./semantic";
import { assessmentPrompt, runNative } from "./native";

export const inputPaths = ["career/criteria.md", "notes/identity.md", "career/opportunities/voyage-role/posting.md",
  "career/opportunities/voyage-role/status.md", "career/opportunities/voyage-role/company-packet.md", "inputs/metadata.json", "inputs/scoring.json", "settings/jobs.json"] as const;
export function completePrompt(root: string) {
  return assessmentPrompt + inputPaths.map(path => `\n\nCOMPLETE INPUT FILE ${path}\n${readFileSync(join(root, path), "utf8")}`).join("");
}
const label = z.enum(["met", "not_met", "unclear"]), strings = z.array(z.string().min(1)).max(128);
const schema = z.object({ passage: label, relocation: label, recommendation: z.enum(["pursue", "skip", "needs-more-information"]),
  explanation: z.string().min(1), alignment: strings, gaps: strings, companyKnown: strings, companyUnknown: strings, evidencePaths: strings }).strict();
/**
 * Cited evidence must be real supplied inputs and must include the posting and the
 * criteria. An assessment that cites a subset of the other inputs is still a valid
 * observation; one that invents a path, repeats one, or skips the posting is not.
 */
export function admissibleEvidencePaths(paths: string[]) {
  const required: string[] = ["career/opportunities/voyage-role/posting.md", "career/criteria.md"];
  return paths.length > 0 && new Set(paths).size === paths.length &&
    paths.every(path => inputPaths.includes(path as typeof inputPaths[number])) && required.every(path => paths.includes(path));
}
export async function collectCurrent(root: string, output: string, token: string, options: Parameters<typeof runNative>[4] = {}) {
  const before = observe(root), prompt = completePrompt(root), native = await runNative(root, output, token, prompt, options), inspected = observe(root);
  if (JSON.stringify(inspected) !== JSON.stringify(before)) throw Error("Report-only native assessment changed whole fixture state");
  const raw = native.receipt.result.result;
  let parsed: unknown = null, accepted: z.infer<typeof schema> | null = null, invalid: string | null = null;
  try {
    parsed = JSON.parse(raw); const candidate = schema.parse(parsed);
    if (!admissibleEvidencePaths(candidate.evidencePaths))
      throw Error("Native assessment must cite the supplied posting and criteria, without invented or repeated paths");
    accepted = candidate;
  } catch (error) { invalid = String(error); }
  const after = observe(root);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw Error("Report-only assessment validation changed whole fixture state");
  return { raw, parsed, accepted, invalid, before, inspected, after, native, promptSha: hash(prompt),
    authority: null, applicationDecision: null, writes: [], fullResearchWorkflowMeasured: false, semanticCorrectness: null, actualInvoiceUsd: null };
}
