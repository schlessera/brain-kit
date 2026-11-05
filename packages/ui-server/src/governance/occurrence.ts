/** Host collection metadata. No trust matching or human verdict authority lives here. */
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const OccurrenceSchema = z.strictObject({
  id, epochId: id, operationId: id.nullable(), signalId: id, exposureId: id,
  detector: z.enum(["tool_web_input", "tool_file_input", "tool_search_output", "external_mcp_input", "attachment_input",
    "compute_input", "unproxied_shell_input", "proxy_input", "explicit_untrusted_input"]),
  // Observation of a result is not proof that input delivery has ended.
  exposure: z.enum(["open", "finalized", "interrupted_unknown"]),
  provenance: z.null(),
});
export type Occurrence = z.infer<typeof OccurrenceSchema>;

export function occurrence(epochId: string, detector: Occurrence["detector"], operationId: string | null,
  exposure: Occurrence["exposure"] = "interrupted_unknown"): Occurrence {
  return { id: crypto.randomUUID(), epochId, operationId, signalId: crypto.randomUUID(), exposureId: crypto.randomUUID(),
    detector, exposure, provenance: null };
}
