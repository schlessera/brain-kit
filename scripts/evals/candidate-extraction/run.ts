import { createJevClient, type JevChoiceQuestion, type JevResult } from "../../../packages/core/src/lib/jev";
import { expectedStart, fixtures, type Fixture } from "./fixtures";
import { conferenceResearch, domainRoles, jobResearch, lexicalChoices, prepare, roles, sha256, type Prepared, type Report, type Role } from "./prototype";

export function authoredChoices(fixture: Fixture, prepared: Prepared): Partial<Record<Role, string>> {
  const choices: Partial<Record<Role, string>> = {};
  for (const role of domainRoles(fixture.domain)) {
    const expected = fixture.expected[role];
    if (!expected?.text) { choices[role] = expected?.status === "absent" ? "none" : "unclear"; continue; }
    const start = expectedStart(fixture.source, expected);
    const candidate = prepared.candidates.find((c) => c.start === start && c.text === expected.text && c.kind === roles[role].kind);
    choices[role] = candidate ? String(candidate.index) : "unclear";
  }
  return choices;
}

/** Actual production response parser over a keyless in-memory transport. Never calls fetch. */
export async function scriptedResult(prepared: Prepared, choices: Partial<Record<Role, string>>, edit?: (raw: Record<string, unknown>) => void): Promise<JevResult> {
  const answers = Object.fromEntries(Object.entries(prepared.request.questions).map(([id, question]) => {
    const choice = choices[id as Role] ?? "unclear";
    const options = Object.keys((question as JevChoiceQuestion).criteria);
    return [id, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])) }];
  }));
  const raw: Record<string, unknown> = { model: "offline-script", answers };
  edit?.(raw);
  const client = createJevClient({ apiKey: "fictional-fixture-key", fetch: async () => Response.json(raw) });
  return client.ask(prepared.request);
}

function assertExpected(fixture: Fixture, report: Report) {
  for (const role of domainRoles(fixture.domain)) {
    const expected = fixture.expected[role]; const actual = report[role];
    if (!actual || actual.status !== (expected?.status ?? "unresolved") || JSON.stringify(actual.value) !== JSON.stringify(expected?.value ?? null)) {
      throw new Error(`${fixture.id}/${role}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    if (expected?.text && expected.candidate !== false) {
      if (!actual.provenance || actual.provenance.start !== expectedStart(fixture.source, expected) || actual.provenance.text !== expected.text) throw new Error(`${fixture.id}/${role}: expected exact source provenance`);
    }
    if (actual.provenance && fixture.source.slice(actual.provenance.start, actual.provenance.end) !== actual.provenance.text) throw new Error(`${fixture.id}/${role}: copied value lacks provenance`);
  }
}

export async function evaluate(repetitions = 5) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error("Repetitions must be 1–100");
  const timings: number[] = [];
  const rows: { id: string; split: string; candidates: number; targets: number; found: number; scripted: Report; lexical: Report }[] = [];
  for (const fixture of fixtures) {
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const started = performance.now();
      const prepared = prepare(fixture.source, fixture.domain);
      const result = await scriptedResult(prepared, authoredChoices(fixture, prepared));
      const consumer = fixture.domain === "cfp" ? conferenceResearch(prepared, result) : jobResearch(prepared, result);
      timings.push(performance.now() - started);
      assertExpected(fixture, consumer.fields);
      if (repeat === 0) {
        const expected = Object.values(fixture.expected).filter((field) => field.text);
        const found = expected.filter((field) => prepared.candidates.some((c) => c.start === expectedStart(fixture.source, field) && c.text === field.text)).length;
        const lexical = (fixture.domain === "cfp" ? conferenceResearch : jobResearch)(prepared, await scriptedResult(prepared, lexicalChoices(prepared))).fields;
        rows.push({ id: fixture.id, split: fixture.split, candidates: prepared.candidates.length, targets: expected.length, found, scripted: consumer.fields, lexical });
      }
    }
  }
  timings.sort((a, b) => a - b);
  const quantile = (q: number) => timings[Math.max(0, Math.ceil(q * timings.length) - 1)];
  const fields = Object.fromEntries((Object.keys(roles) as Role[]).map((role) => {
    const relevant = rows.filter((row) => Object.hasOwn(row.scripted, role));
    const targets = relevant.reduce((n, row) => n + (fixtures.find((f) => f.id === row.id)?.expected[role]?.text ? 1 : 0), 0);
    const found = relevant.reduce((n, row) => {
      const fixture = fixtures.find((f) => f.id === row.id)!; const expected = fixture.expected[role];
      return n + (expected?.text && prepare(fixture.source, fixture.domain).candidates.some((c) => c.kind === roles[role].kind && c.start === expectedStart(fixture.source, expected) && c.text === expected.text) ? 1 : 0);
    }, 0);
    return [role, {
      cases: relevant.length, candidate_targets: targets, candidate_found: found,
      scripted_selected: relevant.filter((r) => r.scripted[role]?.status === "selected").length,
      scripted_absent: relevant.filter((r) => r.scripted[role]?.status === "absent").length,
      scripted_unresolved: relevant.filter((r) => r.scripted[role]?.status === "unresolved").length,
      lexical_status_value_matches: relevant.filter((r) => r.lexical[role]?.status === r.scripted[role]?.status && JSON.stringify(r.lexical[role]?.value) === JSON.stringify(r.scripted[role]?.value)).length,
      live_role_precision: null, live_normalized_precision: null, live_absent_field_errors: null, live_fallback_rate: null,
    }];
  }));
  return {
    evidence: "keyless scripted controls; labels/values authored, not independently reviewed; no model-quality or cost comparison",
    fixture_sha256: sha256(JSON.stringify(fixtures)), schema_sha256: sha256(JSON.stringify(fixtures.map((f) => prepare(f.source, f.domain).request))),
    prototype_sha256: sha256(await Bun.file(new URL("./prototype.ts", import.meta.url)).text()),
    runtime: Bun.version, repetitions, observations: timings.length,
    tuning_cases: fixtures.filter((f) => f.split === "tuning").length, heldout_cases: fixtures.filter((f) => f.split === "heldout").length,
    candidate_targets: rows.reduce((n, r) => n + r.targets, 0), candidate_found: rows.reduce((n, r) => n + r.found, 0),
    candidate_count: rows.reduce((n, r) => n + r.candidates, 0), fields,
    local_control_ms: { p50: quantile(0.5), p95: quantile(0.95), min: timings[0], max: timings[timings.length - 1], throughput_per_second: timings.length * 1000 / timings.reduce((a, b) => a + b, 0), scope: "prepare, request construction, in-memory transport/real response parser, report-only consumer normalization; excludes fixture setup, golden assertions and lexical comparator; no live latency claim" },
    live: { current_agent: null, deterministic_baseline: null, hybrid: null, calls: null, all_tokens: null, billed_cost: null, effective_cost: null, cache_retry_fallback_generation_cost: null, latency: null, model_state_size_sensitivity: null, measured_go_no_go: null },
    network_model_calls: 0, rows,
  };
}
if (import.meta.main) console.log(JSON.stringify(await evaluate(), null, 2));
