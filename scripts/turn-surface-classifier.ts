/** #587 research-only two-pass shortlist. Production Jev transport and its
 * circuit breaker are reused; no shipping router imports this module.
 */
import type { ClassificationAnswers, ClassificationRequest } from "@schlessera/brain-ui-sdk/internal";
import type { JevClient } from "../packages/ui-server/src/classification/jev-client";
import type { SkillEntry, SurfaceTool } from "./turn-surface-routing";

export const ROUTING_MODEL = "jev-1.13.0";
export const ROUTING_THRESHOLD = 0.6;
/** Tool plus skill entries one wide choice question may carry. The 2026-10-07
 * #587 run completed under it, and nothing measured a wider question, so a
 * larger catalogue is refused rather than truncated. */
export const ROUTING_CATALOGUE_BOUND = 64;
/** The `brain-ui` bridge tools `createBrainUiMcpServer` registered at the
 * measured #587 source (380ad6eaf), the same eight the archived native
 * catalogue lists as loaded. The retained live collector routes over these and
 * no later bridge registration, so it keeps the catalogue #587 measured (the
 * #3886 ruling, option 3). Later bridge tools stay on the native surface but
 * outside the routed choice. Core `brain` tools are not filtered. */
export const MEASURED_BRIDGE_ROUTING_TOOLS = [
  "ask_user", "ask_user_form", "ask_user_list", "ask_user_rank",
  "get_current_location", "query_activity", "request_image_mask", "show_block",
] as const;
/** Keep every non-bridge tool and only the measured bridge tools, by name and
 * in listed order. A measured bridge tool that is no longer listed fails, since
 * the control would then route over a catalogue #587 never saw. */
export function measuredRoutingTools(tools: readonly SurfaceTool[]): SurfaceTool[] {
  const measured: readonly string[] = MEASURED_BRIDGE_ROUTING_TOOLS;
  const missing = measured.filter(name => !tools.some(tool => tool.serverName === "brain-ui" && tool.name === name));
  if (missing.length) throw Error(`Measured bridge routing tools missing: ${missing.join(", ")}`);
  return tools.filter(tool => tool.serverName !== "brain-ui" || measured.includes(tool.name));
}
export interface RoutingCatalogue { tools: readonly SurfaceTool[]; skills: readonly SkillEntry[] }
export interface LiveSelection { outcome: string; tools: string[]; skills: string[]; durationMs: number; passes: number }
type Kind = "tool" | "skill";
function entries(catalogue: RoutingCatalogue, kind: Kind): SkillEntry[] {
  return kind === "skill" ? [...catalogue.skills] : catalogue.tools.map(tool => ({ name: tool.id, description: tool.description ?? "" }));
}
function state(prompt: string, previousTail: string) { return { request: prompt, previous_assistant_tail: previousTail.slice(-1000) }; }
export function wideRoutingRequest(prompt: string, previousTail: string, catalogue: RoutingCatalogue): ClassificationRequest {
  if (!catalogue.tools.length || !catalogue.skills.length) throw Error("Invalid routing catalogue: tools and skills must both be nonempty");
  const size = catalogue.tools.length + catalogue.skills.length;
  if (size > ROUTING_CATALOGUE_BOUND) throw Error(`Invalid routing catalogue: ${size} tool and skill entries exceed the ${ROUTING_CATALOGUE_BOUND}-entry bound`);
  const request: ClassificationRequest = { model: ROUTING_MODEL, state: state(prompt, previousTail), questions: {} };
  for (const kind of ["tool", "skill"] as const) {
    request.questions[kind] = { type: "choice", instructions: `Which ${kind} best fits satisfying the current request?`,
      criteria: Object.fromEntries(entries(catalogue, kind).map(entry => [entry.name, entry.description.slice(0, 300)])) };
    request.questions[`needs_${kind}`] = { type: "noul", instructions: kind === "tool"
      ? "Does satisfying this request require an available notebook or interface tool, rather than an explanation in prose alone?"
      : "Does satisfying this request require following an available skill's written procedure, rather than an explanation in prose alone?" };
  }
  return request;
}
function probability(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
export function shortlist(answers: ClassificationAnswers, kind: Kind, catalogue: RoutingCatalogue): SkillEntry[] | null {
  const need = answers[`needs_${kind}`];
  if (need?.type !== "noul" || !probability(need.noul)) return null;
  if (1 - need.noul >= ROUTING_THRESHOLD) return [];
  if (need.noul < ROUTING_THRESHOLD) return null;
  const choice = answers[kind];
  const available = entries(catalogue, kind);
  if (choice?.type !== "choice" || !available.some(entry => entry.name === choice.choice)
    || !probability(choice.confidence) || !choice.probabilities
    || available.some(entry => !probability(choice.probabilities[entry.name]))
    || Object.entries(choice.probabilities).some(([name, value]) => !available.some(entry => entry.name === name) || !probability(value))) return null;
  return available.map((entry, index) => ({ entry, index, score: choice.probabilities[entry.name] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3).map(row => row.entry);
}
export function narrowRoutingRequest(prompt: string, previousTail: string, candidates: Record<Kind, SkillEntry[]>): ClassificationRequest {
  const request: ClassificationRequest = { model: ROUTING_MODEL, state: state(prompt, previousTail), questions: {} };
  for (const kind of ["tool", "skill"] as const) {
    if (!candidates[kind].length) continue;
    request.questions[kind] = { type: "choice", instructions: `Which shortlisted ${kind} fits the current request? Reject guesses through the fit judgments.`,
      criteria: Object.fromEntries(candidates[kind].map(entry => [entry.name, entry.description])) };
    for (const entry of candidates[kind]) request.questions[`fits_${kind}:${entry.name}`] = {
      type: "noul", instructions: `Does satisfying the specific current request require ${entry.name}? ${entry.description}`,
    };
  }
  return request;
}
export function chooseNarrow(answers: ClassificationAnswers, kind: Kind, candidates: readonly SkillEntry[]): string[] | null {
  if (!candidates.length) return [];
  const choice = answers[kind];
  if (choice?.type !== "choice" || !probability(choice.confidence) || choice.confidence < ROUTING_THRESHOLD
    || !candidates.some(entry => entry.name === choice.choice)) return null;
  const fits = candidates.map(entry => ({ name: entry.name, answer: answers[`fits_${kind}:${entry.name}`] }));
  if (fits.some(row => row.answer?.type !== "noul" || !probability(row.answer.noul))) return null;
  const winner = fits.find(row => row.name === choice.choice)!;
  if (winner.answer!.type !== "noul" || Math.min(choice.confidence, winner.answer!.noul) < ROUTING_THRESHOLD) return null;
  // Tools may form a small required set; skill invocation remains one winner.
  return kind === "skill" ? [choice.choice] : fits.filter(row => row.answer!.type === "noul" && row.answer!.noul >= ROUTING_THRESHOLD).map(row => row.name);
}

/** One hard deadline includes both passes. Caller also passes this deadline's
 * AbortSignal into its injected fetch, so abandoned HTTP cannot keep running.
 */
export async function classifySurface(params: {
  client: JevClient; prompt: string; previousTail: string; catalogue: RoutingCatalogue;
  enabled: boolean; deadline: AbortSignal;
}): Promise<LiveSelection> {
  const started = performance.now();
  let passes = 0;
  const finish = (outcome: string, tools: string[] = [], skills: string[] = []): LiveSelection => ({ outcome, tools, skills, passes, durationMs: performance.now() - started });
  if (!params.enabled) return finish("off");
  if (!params.client.enabled) return finish("no_key");
  if (params.client.breaker().open) return finish("circuit_open");
  const abort = new Promise<null>(resolve => {
    if (params.deadline.aborted) resolve(null);
    else params.deadline.addEventListener("abort", () => resolve(null), { once: true });
  });
  const call = (request: ClassificationRequest) => {
    if (params.deadline.aborted) return Promise.resolve(null);
    passes++;
    return Promise.race([params.client.classify(request), abort]);
  };
  const wide = await call(wideRoutingRequest(params.prompt, params.previousTail, params.catalogue));
  if (!wide || params.deadline.aborted) return finish("timeout");
  if (wide.outcome !== "answered" || !wide.answers) return finish(wide.outcome);
  const tools = shortlist(wide.answers, "tool", params.catalogue);
  const skills = shortlist(wide.answers, "skill", params.catalogue);
  if (!tools || !skills) return finish("low_confidence");
  if (!tools.length && !skills.length) return finish("answered");
  const narrow = await call(narrowRoutingRequest(params.prompt, params.previousTail, { tool: tools, skill: skills }));
  if (!narrow || params.deadline.aborted) return finish("timeout");
  if (narrow.outcome !== "answered" || !narrow.answers) return finish(narrow.outcome);
  const pickedTools = chooseNarrow(narrow.answers, "tool", tools);
  const pickedSkills = chooseNarrow(narrow.answers, "skill", skills);
  return pickedTools && pickedSkills ? finish("answered", pickedTools, pickedSkills) : finish("low_confidence");
}
