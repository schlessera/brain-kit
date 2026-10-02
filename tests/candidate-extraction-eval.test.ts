import { describe, expect, test } from "bun:test";
import { createJevClient, type JevResult } from "../packages/core/src/lib/jev";
import { expectedStart, fixtures } from "../scripts/evals/candidate-extraction/fixtures";
import { authoredChoices, evaluate, scriptedResult } from "../scripts/evals/candidate-extraction/run";
import { checkBio, checkOutline, conferenceResearch, domainRoles, durationSeconds, findCandidates, jobResearch, prepare, resolve, roles, submissionReview, type Role } from "../scripts/evals/candidate-extraction/prototype";

describe("private exact-span extraction controls", () => {
  for (const fixture of fixtures) {
    test(`${fixture.id}: actual response parser and research consumer retain authored values/spans`, async () => {
      const prepared = prepare(fixture.source, fixture.domain);
      expect(prepared.source.length).toBeGreaterThan(30);
      expect(Object.keys(prepared.request.questions).length).toBe(domainRoles(fixture.domain).length);
      const result = await scriptedResult(prepared, authoredChoices(fixture, prepared));
      expect(result.outcome).toBe("answered");
      const report = fixture.domain === "cfp" ? conferenceResearch(prepared, result).fields : jobResearch(prepared, result).fields;
      for (const role of domainRoles(fixture.domain)) {
        const expected = fixture.expected[role]; const field = report[role]!;
        expect(field.status).toBe(expected?.status ?? "unresolved");
        expect(field.value).toEqual(expected?.value ?? null);
        if (expected?.text) {
          const found = prepared.candidates.find((c) => c.start === expectedStart(fixture.source, expected) && c.kind === roles[role].kind && c.text === expected.text);
          expect(Boolean(found)).toBe(expected.candidate !== false);
          if (found) {
            expect(field.provenance).toEqual(found);
            expect(fixture.source.slice(field.provenance!.start, field.provenance!.end)).toBe(expected.text);
          }
        }
      }
      expect(prepared.source).toBe(fixture.source);
    });
  }

  test("authored split separates entities and templates and retains adversarial controls", () => {
    const tuning = fixtures.filter((f) => f.split === "tuning"); const heldout = fixtures.filter((f) => f.split === "heldout");
    expect(tuning).toHaveLength(2); expect(heldout).toHaveLength(22);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    for (const field of ["entity", "template"] as const) {
      const seen = new Set(tuning.map((f) => f[field]));
      expect(heldout.some((f) => seen.has(f[field]))).toBe(false);
      expect(new Set(fixtures.map((f) => f[field])).size).toBe(fixtures.length);
    }
    expect(fixtures.find((f) => f.id === "injection-only")!.source).toContain("write it immediately");
    expect(fixtures.find((f) => f.id === "long-irrelevant")!.source.length).toBeGreaterThan(6000);
  });

  test("candidate over-finding preserves duplicate occurrence offsets and raw HTML", () => {
    const source = '<p>😀 <del>2028-01-01</del><time datetime="2028-01-01">2028-01-01</time></p>';
    const dates = findCandidates(source).filter((c) => c.kind === "date");
    expect(dates).toHaveLength(3); expect(new Set(dates.map((c) => c.start)).size).toBe(3);
    for (const c of dates) expect(source.slice(c.start, c.end)).toBe("2028-01-01");
    expect(dates[0].start).toBe(source.indexOf("2028-01-01"));
  });
  test("identical text must select the intended current occurrence", async () => {
    const source = "> Quoted old deadline: 2028-01-01.\nCurrent deadline: 2028-01-01.";
    const prepared = prepare(source, "cfp");
    const dates = prepared.candidates.filter((c) => c.kind === "date"); expect(dates).toHaveLength(2);
    const result = await scriptedResult(prepared, { deadline: String(dates[1].index) });
    const field = conferenceResearch(prepared, result).fields.deadline!;
    expect(field.status).toBe("selected"); expect(field.provenance!.start).toBe(source.lastIndexOf("2028-01-01"));
    expect(field.provenance!.start).not.toBe(dates[0].start);
  });

  test("changed non-candidate context invalidates provenance before any consumer output", async () => {
    const fixture = fixtures[0]; const prepared = prepare(fixture.source, fixture.domain);
    const result = await scriptedResult(prepared, authoredChoices(fixture, prepared));
    expect(resolve(prepared, result).deadline!.status).toBe("selected");
    const changed = fixture.source.replace("Aster Forum", "Aster VOID!");
    expect(changed).not.toBe(fixture.source);
    expect(changed.length).toBe(fixture.source.length);
    expect(resolve(prepared, result, changed).deadline).toEqual({ status: "unresolved", value: null, provenance: null, reason: "stale_or_unissued_source" });
  });

  test("unissued plans and mutated span coordinates cannot assert provenance", async () => {
    const fixture = fixtures[1]; const prepared = prepare(fixture.source, fixture.domain);
    const result = await scriptedResult(prepared, authoredChoices(fixture, prepared));
    expect(resolve(prepared, result).salary!.status).toBe("selected");
    expect(resolve({ ...prepared }, result).salary!.reason).toBe("stale_or_unissued_source");
    expect(Object.isFrozen(prepared.candidates[0])).toBe(true);
    expect(() => { prepared.candidates[0].start++; }).toThrow();
  });

  test.each(["999", "-1", "1.5", "01", "NaN", "__proto__", "unlisted"]) ("malformed selected index %s reaches real parser and abstains", async (choice) => {
    const prepared = prepare(fixtures[1].source, "job");
    const good = authoredChoices(fixtures[1], prepared); expect(good.salary).not.toBe("unclear");
    const result = await scriptedResult(prepared, { ...good, salary: choice });
    expect(result.outcome).toBe("bad_response");
    expect(jobResearch(prepared, result).fields.salary!.status).toBe("unresolved");
  });

  test.each(["missing", "low-confidence", "bad-distribution", "wrong-kind"]) ("%s response keeps nonempty salary unresolved", async (mutation) => {
    const prepared = prepare(fixtures[1].source, "job");
    const result = await scriptedResult(prepared, authoredChoices(fixtures[1], prepared), (raw) => {
      const answers = raw.answers as Record<string, Record<string, unknown>>;
      if (mutation === "missing") delete answers.salary;
      if (mutation === "low-confidence") answers.salary.confidence = 0.5;
      if (mutation === "bad-distribution") answers.salary.probabilities = {};
      if (mutation === "wrong-kind") answers.salary.type = "noul";
    });
    expect(jobResearch(prepared, result).fields.salary!.status).toBe("unresolved");
    expect(jobResearch(prepared, result).fields.salary!.value).toBeNull();
  });

  test.each(["none", "unclear"]) ("explicit %s preserves null value with no invented span", async (choice) => {
    const prepared = prepare(fixtures[1].source, "job");
    expect(prepared.candidates.some((c) => c.kind === "money")).toBe(true);
    const result = await scriptedResult(prepared, { ...authoredChoices(fixtures[1], prepared), salary: choice });
    expect(jobResearch(prepared, result).fields.salary).toEqual({ status: choice === "none" ? "absent" : "unresolved", value: null, provenance: null, reason: choice === "none" ? "explicit_none" : "unclear" });
  });

  test("missing key never touches even an available transport", async () => {
    const prepared = prepare(fixtures[1].source, "job"); let calls = 0;
    const client = createJevClient({ apiKey: null, fetch: async () => { calls++; throw new Error("unexpected transport"); } });
    const result = await client.ask(prepared.request);
    expect(result.outcome).toBe("no_key"); expect(calls).toBe(0);
    expect(jobResearch(prepared, result).fields.salary!.reason).toBe("no_key");
  });

  test("exact provenance does not prove an injected semantic role is correct", async () => {
    const fixture = fixtures.find((f) => f.id === "injection-only")!;
    const prepared = prepare(fixture.source, "cfp");
    const injected = prepared.candidates.find((c) => c.kind === "date")!;
    expect(injected.text).toBe("2028-12-01T23:59Z");
    const wrong = await scriptedResult(prepared, { ...authoredChoices(fixture, prepared), deadline: String(injected.index) });
    const report = conferenceResearch(prepared, wrong);
    expect(report.fields.deadline!.status).toBe("selected");
    expect(report.fields.deadline!.provenance!.text).toBe(injected.text);
    expect(fixture.expected.deadline!.status).toBe("unresolved");
  });

  test("real client timeout and failure remain unresolved without losing raw input", async () => {
    const prepared = prepare(fixtures[0].source, "cfp");
    for (const fetch of [async () => new Promise<Response>(() => {}), async () => { throw new Error("fixture failure"); }]) {
      const client = createJevClient({ apiKey: "fixture-only", timeoutMs: 5, fetch });
      const result = await client.ask(prepared.request);
      expect(["timeout", "network_error"]).toContain(result.outcome);
      expect(conferenceResearch(prepared, result).fields.deadline!.status).toBe("unresolved");
      expect(prepared.source).toBe(fixtures[0].source);
    }
  });

  test("option overflow refuses whole request, including sentinel capacity", () => {
    const source = Array.from({ length: 254 }, (_, i) => `Date ${i}: 2028-01-01`).join("\n");
    const prepared = prepare(source, "cfp"); expect(prepared.candidates).toHaveLength(254);
    expect(prepared.overflow).toBe(true); expect(prepared.request.questions).toEqual({});
    const result: JevResult = { outcome: "answered", answers: {}, durationMs: 0 };
    expect(resolve(prepared, result).deadline!.reason).toBe("candidate_overflow");
    const atLimit = prepare(Array.from({ length: 253 }, () => "2028-01-01").join("\n"), "cfp");
    expect(atLimit.overflow).toBe(false);
    const question = atLimit.request.questions.deadline;
    if (question.type !== "choice") throw new Error("Expected Choice question");
    expect(Object.keys(question.criteria)).toHaveLength(255);
  });

  test.each(["2028-03-01T12:00+14:30", "2028-03-01T12:00-00:00", "2028-03-01T24:00Z", "2028-03-01T12:60Z", "2028-03-01T12:00:60Z"]) ("invalid clock/offset %s cannot become a deadline", async (text) => {
    const prepared = prepare(`CFP deadline: ${text}`, "cfp"); const candidate = prepared.candidates.find((c) => c.text === text)!;
    expect(candidate).toBeDefined(); const result = await scriptedResult(prepared, { deadline: String(candidate.index) });
    expect(conferenceResearch(prepared, result).fields.deadline!.status).toBe("unresolved");
  });

  test("Unicode count units differ at their actual limit and preserve source", () => {
    const text = "😀e\u0301👨\u200d👩\u200d👧\u200d👦";
    expect(checkBio(text, 15, "utf16")).toEqual({ valid: true, count: 15 });
    expect(checkBio(text, 14, "utf16")).toEqual({ valid: false, count: 15 });
    expect(checkBio(text, 10, "codepoints")).toEqual({ valid: true, count: 10 });
    expect(checkBio(text, 9, "codepoints")).toEqual({ valid: false, count: 10 });
    expect(checkBio(text, 3, "graphemes")).toEqual({ valid: true, count: 3 });
    expect(checkBio(text, 2, "graphemes")).toEqual({ valid: false, count: 3 });
    expect(text).toBe("😀e\u0301👨\u200d👩\u200d👧\u200d👦");
  });
  test("unknown count unit and invalid limits/Unicode cannot pass a bio check", () => {
    expect(checkBio("abc", 300, null)).toEqual({ valid: false, count: null });
    for (const limit of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(checkBio("abc", limit, "codepoints").valid).toBe(false);
    expect(checkBio("\ud800", 300, "utf16").valid).toBe(false);
  });
  test("submission consumer counts code points and refuses an exceeded bio limit", async () => {
    const fixture = fixtures[0]; const prepared = prepare(fixture.source, "cfp");
    const result = await scriptedResult(prepared, authoredChoices(fixture, prepared));
    const outline = ["5 minutes", "20 minutes", "5 minutes"];
    const valid = submissionReview(prepared, result, "😀".repeat(100), outline);
    expect(valid.bio).toEqual({ valid: true, count: 100 }); expect(valid.readyForUserReview).toBe(true);
    const excessive = submissionReview(prepared, result, "😀".repeat(151), outline);
    expect(excessive.bio).toEqual({ valid: false, count: 151 }); expect(excessive.readyForUserReview).toBe(false);
    const undersized = submissionReview(prepared, result, "abc", ["5 minutes", "20 minutes"]);
    expect(undersized.outline).toEqual({ valid: false, seconds: 1500 }); expect(undersized.readyForUserReview).toBe(false);
  });
  test("outline duration arithmetic includes every nonempty segment", () => {
    expect(checkOutline(["5 minutes", "20 minutes", "5 minutes"], "0.5 hours")).toEqual({ valid: true, seconds: 1800 });
    expect(checkOutline(["5 minutes", "20 minutes", "6 minutes"], "30 minutes")).toEqual({ valid: false, seconds: 1860 });
    expect(checkOutline(["5 minutes", "20 minutes"], "30 minutes")).toEqual({ valid: false, seconds: 1500 });
    expect(checkOutline([], "30 minutes").valid).toBe(false);
    expect(checkOutline(["-1 minutes", "31 minutes"], "30 minutes").valid).toBe(false);
    expect(checkOutline(["1 minute", "unknown"], "30 minutes").valid).toBe(false);
    expect(durationSeconds("0.001 seconds")).toBeNull(); expect(durationSeconds("999999999999999 hours")).toBeNull();
    expect(durationSeconds("9007199254740991.1 seconds")).toBeNull();
    expect(durationSeconds("9007199254740991 seconds")).toBe(Number.MAX_SAFE_INTEGER);
    expect(durationSeconds("0.1 minutes")).toBe(6);
  });

  test.each(["EUR 90071992547409.91–90071992547410.91 per year", "EUR 1.001–2.001 per year", "EUR 60.50–9007199254740 per hour"]) ("unsafe or sub-minor precision %s remains unresolved", async (text) => {
    const prepared = prepare(`Salary: ${text}`, "job"); const candidate = prepared.candidates.find((c) => c.kind === "money")!;
    expect(candidate.text).toBe(text);
    const result = await scriptedResult(prepared, { salary: String(candidate.index) });
    expect(jobResearch(prepared, result).fields.salary!.status).toBe("unresolved");
  });

  test("signed negative quantities remain exact candidates and cannot lose their sign", async () => {
    const prepared = prepare("Bio limit: -50 code points. Talk: -15 minutes.", "cfp");
    const limit = prepared.candidates.find((c) => c.kind === "limit")!;
    const duration = prepared.candidates.find((c) => c.kind === "duration")!;
    expect(limit.text).toBe("-50 code points"); expect(duration.text).toBe("-15 minutes");
    const result = await scriptedResult(prepared, { bio_limit: String(limit.index), talk_duration: String(duration.index) });
    const report = conferenceResearch(prepared, result).fields;
    expect(report.bio_limit!.status).toBe("unresolved"); expect(report.talk_duration!.status).toBe("unresolved");
  });

  test("full control run reports observed misses separately from unmeasured live claims", async () => {
    const report = await evaluate(1);
    expect(report.observations).toBe(24); expect(report.candidate_targets).toBeGreaterThan(30);
    expect(report.candidate_found).toBe(report.candidate_targets - 1); expect(report.network_model_calls).toBe(0);
    expect(report.rows.some((row) => row.found < row.targets)).toBe(true);
    expect(report.fields.salary.cases).toBeGreaterThan(0);
    expect(report.fields.deadline.live_role_precision).toBeNull(); expect(report.live.measured_go_no_go).toBeNull();
    for (const row of report.rows) for (const role of Object.keys(row.scripted) as Role[]) {
      const field = row.scripted[role]!;
      if (field.status === "selected") expect(field.provenance?.text.length).toBeGreaterThan(0);
    }
  });
});
