import { expect, test } from "bun:test";
import { score, readFields, type Row } from "../evals/849-candidate-extraction/run";

const row = (repetition: number, occurrence = 1): Row => ({ arm: "candidate", id: "held-duplicate-date", repetition, invalid: false, fields: { deadline: { role: "span", text: "2028-07-01", occurrence } } });

test("duplicate source values need the current occurrence; wrong selection is both FP and FN", () => {
  const s = score([row(0, 0), row(1), row(2)]).candidate;
  expect(s.perField.deadline).toMatchObject({ positives: 3, predictions: 3, truePositives: 2, precision: 2 / 3, recall: 2 / 3 });
  expect(s.correct).toBe(20);
  expect(s.total).toBe(21);
  expect(s.agreement).toEqual({ agreements: 6, compared: 7 });
  expect(s.invented).toBe(0);
});

test("absent predictions have undefined precision and zero recall, rather than perfect extraction", () => {
  const r = row(0); r.fields = {};
  const s = score([r]).candidate;
  expect(s.precision).toBeNull(); expect(s.recall).toBe(0); expect(s.abstentions).toBe(7);
});

test("invented text and nonexistent occurrences are vetoes, including negative occurrences", () => {
  const a = row(0); a.fields.deadline!.text = "2028-07-99";
  expect(score([a, row(1, 2), row(2, -1)]).candidate.invented).toBe(3);
});

test("invalid reports cannot earn accuracy or agreement from default unclear fields", () => {
  const rows = [row(0), row(1), row(2)]; rows[1]!.invalid = true;
  const s = score(rows).candidate;
  expect(s.invalid).toBe(1); expect(s.correct).toBe(14); expect(s.agreement.agreements).toBe(0);
});

test("tuning rows never contribute to held-out counts", () => {
  const r = row(0); r.id = "tune-direct";
  expect(score([r]).candidate.total).toBe(0);
});

test("uncertain currency is a correct extraction with no normalized value claimed", () => {
  const r: Row = { arm: "candidate", id: "held-currency", repetition: 0, invalid: false, fields: { salary: { role: "span", text: "$120,000–140,000 per year", occurrence: 0 } } };
  const s = score([r]).candidate;
  expect(s.truePositives).toBe(1);
  expect(s.normalized).toEqual({ truePositives: 0, positives: 0, predictions: 0 });
});

test("hourly bounds retain source period rather than an invented annual-hours assumption", () => {
  const r: Row = { arm: "candidate", id: "held-hourly", repetition: 0, invalid: false, fields: { salary: { role: "span", text: "GBP 60.50–70.25 per hour", occurrence: 0 } } };
  expect(score([r]).candidate.normalized).toEqual({ truePositives: 1, positives: 1, predictions: 1 });
});

test("scoreable JSON within the agent text report survives a prose preface; malformed fields are invalid", () => {
  const text = 'Research complete.\n{"fields":{"deadline":{"role":"span","text":"2028-07-01","occurrence":1}}}';
  const r = row(0); r.fields = readFields(text, ["deadline"]);
  expect(score([r]).candidate.truePositives).toBe(1);
  expect(() => readFields('{"fields":{}}', ["deadline"])).toThrow("Invalid field deadline");
});

test("a source deadline claimed as an unannounced event end is an invented field value veto", () => {
  const r = row(0); r.fields.event_end = { role: "span", text: "2028-07-01", occurrence: 1 };
  const s = score([r]).candidate;
  expect(s.invented).toBe(1); expect(s.inventedLiteral).toBe(0); expect(s.unsupportedClaims).toBe(1);
});
