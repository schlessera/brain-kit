import { describe, expect, test } from "bun:test";
import { parseSalaryRange } from "../src/salary";

describe("parseSalaryRange", () => {
  test("annual range parses normally", () => {
    const p = parseSalaryRange("$120,000 - $150,000");
    expect(p.min).toBe(120_000);
    expect(p.max).toBe(150_000);
    expect(p.annualizedFromHourly).toBe(false);
  });

  test("hourly range with decimals is annualized and does not split on the dot", () => {
    // Annualization uses the documented 2,080 hours/year, pinned independently
    // of the implementation constant. The old parser turned "$60.50 - $75 per hour" into min 60, max 50
    const p = parseSalaryRange("$60.50 - $75 per hour");
    expect(p.min).toBe(125_840);
    expect(p.max).toBe(156_000);
    expect(p.annualizedFromHourly).toBe(true);
  });

  test("'/hr' marker is detected", () => {
    const p = parseSalaryRange("$40 - $55/hr");
    expect(p.min).toBe(83_200);
    expect(p.max).toBe(114_400);
    expect(p.annualizedFromHourly).toBe(true);
  });

  test("'hourly' marker is detected", () => {
    const p = parseSalaryRange("USD 30 - 45 hourly");
    expect(p.min).toBe(62_400);
    expect(p.annualizedFromHourly).toBe(true);
  });

  test("single figure yields no range", () => {
    const p = parseSalaryRange("$150,000+");
    expect(p.min).toBeUndefined();
    expect(p.max).toBeUndefined();
  });

  test("no numbers yields no range", () => {
    const p = parseSalaryRange("Competitive");
    expect(p.min).toBeUndefined();
    expect(p.max).toBeUndefined();
    expect(p.annualizedFromHourly).toBe(false);
  });
});
