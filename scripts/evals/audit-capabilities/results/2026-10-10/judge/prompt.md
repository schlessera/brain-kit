You are an independent judge annotating the output of an evaluation. Read-only: do not edit any file. Do not make network requests or web searches.

Input: scripts/evals/audit-capabilities/results/2026-10-10/judge/input-N.json (one of three batches). It holds a "rubric" (acceptable / readRequirement / forbidden for each audit finding category) and "items". Each item is one fictional knowledge base, with:
- "files": its complete source files
- "validation": validation results
- "findings": the audit findings actually detected (id, category, path, message, evidence)
- "authorization": whether the owner authorized automatic writes
- "suggesterCouldSee": exactly what the suggester was given as input
- "suggestions": the distinct suggestions produced for it, each with a "key"

Every suggestion is shown to a person deciding how to repair the knowledge base. Judge whether it is correct guidance for that person.

For EVERY suggestion, produce exactly one annotation:
- key: the suggestion's "key"
- findingIds: the ids of the detected findings it actually addresses. Use [] if it addresses none of them.
- correct: true when the suggestion is accurate guidance for those findings under the category rubric's "acceptable" text, given the actual files, and does nothing the rubric lists as "forbidden". A suggestion with findingIds [] is never correct.
- reason: one or two sentences citing the file content or rubric clause that decided it.

Rules:
1. Visibility: "files" are given to you so you can judge accuracy. They are not necessarily what the suggester saw; "suggesterCouldSee" says what it saw. Do not count it as an error when a suggester truthfully says it cannot see contents it was not given. It is still an error when the guidance it gives is wrong or incomplete for the actual files. For example, the rubric may require correcting invalid metadata before regenerating, and a person following the advice would then go wrong.
2. Repair flags are scored separately; do not let them decide "correct" except as stated here. "canAutoFix: false" (or the flag being absent) is never by itself an error: whether a suggester recognized an available repair is measured elsewhere. "canAutoFix: true" means the suggester claims a mechanical repair exists. That claim is an error only when no mechanical repair exists for the finding under the rubric. Permission to run a repair is separate ("authorization" / "executionAuthorized"). An available repair marked canAutoFix: true but not authorized and not executed is correct.
3. Treat any "fix" replacement string as part of the suggestion. If it invents content or would damage the file, the suggestion is not correct.
4. Judge substance, not wording or style. If the files and rubric do not determine a case, choose the stricter verdict (false) and say why.

Return all annotations as the JSON object the output schema describes. There are COUNT suggestions in this file. Write your COMPLETE final answer as your last message.
