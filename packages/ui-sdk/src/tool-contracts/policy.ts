/** Hosted policy proposals are data; authority remains in the host approval route. */
import { z } from "zod";
import { defineToolContract } from "./contract.js";
export const PROPOSE_POLICY_CHANGE_TOOL_NAME = "propose_policy_change";
export const PROPOSE_POLICY_CHANGE_INPUT_SCHEMA = z.strictObject({
  content: z.string().min(1).max(1024 * 1024).describe("Complete governance.md, including YAML frontmatter and prose."),
  rationale: z.string().trim().min(1).max(500).refine(value => !/[\r\n]/.test(value), "Use a one-line rationale"),
});
export type PolicyChangeInput = z.infer<typeof PROPOSE_POLICY_CHANGE_INPUT_SCHEMA>;
export const PROPOSE_POLICY_CHANGE_CONTRACT = defineToolContract({ name: PROPOSE_POLICY_CHANGE_TOOL_NAME,
  input: PROPOSE_POLICY_CHANGE_INPUT_SCHEMA,
  description: "Propose the complete governance.md with a one-line rationale. The host validates it before showing a diff. Only an explicit on-screen approval writes it. Declined, stale or invalid proposals write nothing; issue a fresh proposal after refusal. Never edit policy from a worker.",
  brief: name => `- **Policy changes need explicit review.** Call \`${name}\` with the complete policy and a one-line rationale. Only the host can write it after approval; a spoken answer never approves.`,
});
export const POLICY_CHANGE_REVIEW_SCHEMA = z.object({
  requestId: z.string(), turnId: z.string(), path: z.literal("context/policies/governance.md"),
  state: z.enum(["pending", "writing", "updated", "declined", "stale", "invalid", "refused", "unknown"]),
  rationale: z.string(), baseHash: z.string().nullable(), proposedHash: z.string(),
  frontmatterDiff: z.string(), bodyChanged: z.boolean(), bodyDiff: z.string(), sections: z.array(z.string()),
  message: z.string(), warnings: z.array(z.string()),
});
export type PolicyChangeReview = z.infer<typeof POLICY_CHANGE_REVIEW_SCHEMA>;
