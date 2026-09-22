/**
 * Classification of what the model typed (D42): the deterministic detector,
 * the question catalogue, and the request/answer plumbing. Importable by
 * the server, which owns the transport, and by tests. No network here.
 */

export {
  detectCandidates,
  parseMarkdown,
  type BlockquoteCandidate,
  type Candidate,
  type CandidateKind,
  type CandidateSpan,
  type KeyValueRunCandidate,
  type OrderedListCandidate,
  type TableCandidate,
  type TimedListCandidate,
} from "./detect.js";

export {
  CANDIDATE_KINDS,
  CATALOGUE_BLOCK_KINDS,
  CONFIDENCE,
  questionsFor,
  transformCandidate,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Classified,
  type ClassificationAnswer,
  type ClassificationAnswers,
  type ClassificationQuestion,
  type NoulAnswer,
  type NoulQuestion,
} from "./catalogue.js";

export {
  CLASSIFIER_MODEL,
  applyClassification,
  planClassification,
  type ClassificationPlan,
  type ClassificationRequest,
  type PlannedCandidate,
} from "./request.js";
