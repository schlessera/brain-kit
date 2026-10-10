// A `jev` choice request over one Odysseus-world job notice, for
// tests/jev-research-outcomes.test.ts. Each question's options are "none",
// "unclear" and the indices of the exact source spans of its kind, so only
// those keys are valid choices.
import type { JevChoiceQuestion, JevRequest } from "../../../packages/core/src/lib/jev";

export const SOURCE = "# Phaeacian Shipyard: harbour planner — Odysseus\nSalary: EUR 120,000–140,000 per year\nApply: https://linden.example/jobs/1\nRecruiter: team@linden.example\nSigning bonus: EUR 5,000. Footer: support@linden.example";

const candidates = [
  { index: 0, kind: "money", text: "EUR 120,000–140,000 per year" },
  { index: 1, kind: "url", text: "https://linden.example/jobs/1" },
  { index: 2, kind: "email", text: "team@linden.example" },
  { index: 3, kind: "money", text: "EUR 5,000." },
  { index: 4, kind: "email", text: "support@linden.example" },
] as const;

const question = (kind: string, meaning: string): JevChoiceQuestion => {
  const criteria: Record<string, string> = {
    none: "This field is explicitly absent. No candidate is the requested value.",
    unclear: "Evidence is ambiguous, missing or contradictory.",
  };
  for (const c of candidates.filter((c) => c.kind === kind)) {
    criteria[String(c.index)] = `Exact source span ${start(c.text)}: ${c.text}`;
  }
  return { type: "choice", instructions: `Select ${meaning}. Select only an exact listed span.`, criteria };
};
const start = (text: string) => SOURCE.indexOf(text);

export function jobRequest(): JevRequest {
  return {
    model: "jev-1.13.0",
    state: { source: SOURCE, domain: "job", candidates },
    questions: {
      salary: question("money", "the current salary range for this role"),
      apply_url: question("url", "the application URL for this role"),
      contact_email: question("email", "the current recruitment contact email"),
    },
  };
}

/** The well-formed choice for each question: the span the notice means. */
export const GOOD_CHOICES: Record<string, string> = { salary: "0", apply_url: "1", contact_email: "2" };

/** A raw response body picking `choices`, one-hot over each question's own options. */
export function scriptedBody(request: JevRequest, choices: Record<string, string>) {
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const choice = choices[id] ?? "unclear";
    const options = Object.keys((q as JevChoiceQuestion).criteria);
    return [id, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0])) }];
  }));
  return { model: "offline-script", answers };
}
