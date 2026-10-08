/** Prospective private comparison. Preparation is not semantic approval or measured quality. */
import { CORPUS_SHA, corpus } from "./corpus";
import { digest } from "./source-admission";
export const protocol = {
  issue: 846,
  day: "2026-07-12",
  models: { current: "claude-sonnet-5-5", hybrid: "jev-1.13.0" },
  runtime: { bun: "1.4.2", sdk: "0.3.293", native: "2.1.293" },
  corpusSha: CORPUS_SHA,
  tuning: corpus.filter(c => c.split === "tuning").map(c => c.id),
  heldOut: corpus.filter(c => c.split === "held-out").map(c => c.id),
  repetitions: 3,
  candidateSizes: [3, 32, 128],
  arms: ["current-submission-outcome/conference-aftermath", "explicit-owner-input", "jev-proposal/explicit-confirmation/code"],
  sourceSkills: ["packages/module-speaking/skills/submission-outcome/SKILL.md", "packages/module-speaking/skills/conference-aftermath/SKILL.md"],
  currentArm: "Run the actual installed core-native route and scoped original skill instructions on complete fresh brains. Grade semantic fields and affected layers, permitting current Markdown layout; do not coach the baseline to adopt the candidate's private field/region representation. Preserve talk content, travel, unrelated submissions and authority. Retrospective generation is excluded equally across arms.",
  humanWork: "Count explicit target/outcome/date/condition mapping, clarification and exact payload confirmation. A structured-input control does not establish extraction or work savings. JEV outcome proposals are unconfirmed and may not authorize writing or archive. Delivery/withdrawal/closure remain separately owner-confirmed inputs.",
  authority: "Literal Decision date/Confirmation deadline/Slides deadline/Condition labels only for bounded classifier extraction. Any other supported-looking date or condition makes extraction abstain. Explicit accepted-with-condition differs from revision pending decision; the representation establishes no new production policy. Closure requires explicit event-over evidence at/after event end. Submission outcome differs from document active/archive status.",
  threshold: "null until complete tuning-only actual observations pass calibration; freeze the selected floor before any held-out run. Three tuning templates and correlated repetitions are insufficient for a general population guarantee.",
  destructiveVeto: ["wrong target", "unsourced deadline", "unconfirmed write", "early archive", "content loss", "unobserved side effect"],
  quality: ["outcome/target precision", "coverage/abstention", "condition/date exactness", "all-layer consistency", "mixed history", "replay/duplicate rows/events", "delivery/archive timing", "full-file preservation"],
  measurement: ["every physical raw request/response", "calls/retries/fallbacks/clarifications", "input/output/cache tokens with unknown distinct from zero", "auxiliary native calls and usage", "actual additional billed charge, unknown invoice retained", "API-price equivalent diagnostic only", "end-to-end human/model work", "p50/p95/raw samples/spread", "candidate retrieval and throughput"],
  nativePolicy: "Current core omission implies native auto. No permission-mode substitution. Live baseline remains refused until #1275 auxiliary classification calls and accounting are completely observed. Fake Messages controls establish literal transport/runtime/drain mechanics only.",
  dispatch: "Global Claude hold remains active. No live entry point in this preparation. Before credentials: root actual-charge reservation, exact full-source/runtime/brain freeze, complementary approval for every whole-case/source packet, public hash readback and verified included availability/extra-usage state. No mixed frozen instrument or implicit future-day reuse.",
  limits: ["historical 21 workflows/10 draft emails are regression controls", "fresh 16 authored brains have disjoint identities/sources but shared schema/projection compositor", "author-provisional goldens require complementary Claude review", "sparse tuning and bounded labelled extraction limit coverage", "existing private Markdown batch writer is not a durable transaction or production lock/recovery design", "snapshot covers descendants, bytes, modes, links and nanosecond mtimes; root-directory metadata is excluded", "archive control covers identified hub/submissions, not every possible conference-owned document", "current baseline semantic grader and measured native/jev comparison remain required"],
} as const;
export const PROTOCOL_SHA = digest(JSON.stringify(protocol));
