/** Host collection metadata. No trust matching or human verdict authority lives here. */
import { z } from "zod";
import { safetyOccurrenceAdmissionSchema } from "@schlessera/brain-ui-sdk/internal";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const OccurrenceSchema = safetyOccurrenceAdmissionSchema.safeExtend({
  id, epochId: id, operationId: id.nullable(), signalId: id, exposureId: id,
  /** Captured by the host collector, never inferred from display content. */
  entry: z.strictObject({kind:z.literal("tool"),toolUseId:id}).optional(),
  detector: z.enum(["tool_web_input", "tool_file_input", "tool_search_output", "external_mcp_input", "attachment_input",
    "compute_input", "unproxied_shell_input", "proxy_input", "explicit_untrusted_input"]),
  // Observation of a result is not proof that input delivery has ended.
  exposure: z.enum(["open", "finalized", "interrupted_unknown"]),
}).strict();
export type Occurrence = z.infer<typeof OccurrenceSchema>;

export function occurrence(epochId: string, detector: Occurrence["detector"], operationId: string | null,
  exposure: Occurrence["exposure"] = "interrupted_unknown"): Occurrence {
  return { id: crypto.randomUUID(), epochId, operationId, signalId: crypto.randomUUID(), exposureId: crypto.randomUUID(),
    detector, exposure, provenance: null,admission:{trusted:false,policyHash:null,trustRevision:"0"} };
}
