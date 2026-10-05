import { expect, test } from "bun:test";

import {
  canonicalTimeZone,
  cronInstantsBetween,
  latestCronInstant,
  nextCronInstant,
  parseCron,
  parseInstant,
  wallTimeInstant,
} from "../src/schedules/time.js";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

test("cron grammar accepts the numeric five-field forms and refuses extensions", () => {
  for (const ok of ["* * * * *", "0 7 * * 1-5", "*/15 0-23/2 1,15 1-12 0", "0 0 * * 7", "5,10-20/5 * * * *", "0 0 29 2 *"]) {
    expect(() => parseCron(ok)).not.toThrow();
  }
  for (const bad of ["", "* * * *", "* * * * * *", "@daily", "0 7 * * MON", "60 * * * *", "* 24 * * *", "* * 0 * *",
    "* * * 13 *", "* * * * 8", "*/0 * * * *", "5/10 * * * *", "10-5 * * * *", " * * * * *", "*  * * * *",
    "0 0 30 2 *", "0 0 31 4,6,9,11 *", "x".repeat(129)]) {
    expect(() => parseCron(bad)).toThrow();
  }
});

test("Sunday is both 0 and 7, and a starred day field requires both day predicates", () => {
  expect(parseCron("0 0 * * 7").weekdays).toEqual(new Set([0]));
  // Day 13 OR Friday when neither day field is starred (cronie semantics).
  const either = parseCron("0 12 13 * 5");
  const fridays = cronInstantsBetween(either, "UTC", at("2026-11-01T00:00:00Z"), at("2026-11-30T23:59:00Z")).map(iso);
  expect(fridays).toEqual(["2026-11-06T12:00:00.000Z", "2026-11-13T12:00:00.000Z", "2026-11-20T12:00:00.000Z", "2026-11-27T12:00:00.000Z"]);
  // A stepped wildcard day field still starts with `*`: both must match.
  const both = parseCron("0 12 */2 * 5");
  const odd = cronInstantsBetween(both, "UTC", at("2026-11-01T00:00:00Z"), at("2026-11-30T23:59:00Z")).map(iso);
  expect(odd).toEqual(["2026-11-13T12:00:00.000Z", "2026-11-27T12:00:00.000Z"]);
  // A wildcard later in a list does not set the star flag.
  const listed = parseCron("0 12 1,* * 5");
  expect(listed.dayStar).toBe(false);
});

test("leap days and month lengths come from the real calendar", () => {
  const leap = parseCron("0 9 29 2 *");
  expect(iso(nextCronInstant(leap, "UTC", at("2026-07-12T00:00:00Z")))).toBe("2028-02-29T09:00:00.000Z");
  const thirtyFirst = parseCron("0 0 31 * *");
  expect(iso(nextCronInstant(thirtyFirst, "UTC", at("2026-04-01T00:00:00Z")))).toBe("2026-05-31T00:00:00.000Z");
});

test("recurrence is computed in the task's own zone across DST, skipping gaps and running folds once", () => {
  // Europe/Athens springs forward at 03:00 on 2026-03-29 and falls back at 04:00 on 2026-10-25.
  const daily = parseCron("30 3 * * *");
  const spring = cronInstantsBetween(daily, "Europe/Athens", at("2026-03-28T00:00:00Z"), at("2026-03-30T23:00:00Z")).map(iso);
  expect(spring).toEqual(["2026-03-28T01:30:00.000Z", "2026-03-30T00:30:00.000Z"]);
  const fall = cronInstantsBetween(daily, "Europe/Athens", at("2026-10-24T00:00:00Z"), at("2026-10-26T23:00:00Z")).map(iso);
  // 03:30 happens at 00:30Z and again at 01:30Z on the 25th; only the earlier runs.
  expect(fall).toEqual(["2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
  expect(wallTimeInstant("Europe/Athens", 2026, 3, 29, 3, 30)).toBeNull();
  expect(iso(wallTimeInstant("Europe/Athens", 2026, 10, 25, 3, 30))).toBe("2026-10-25T00:30:00.000Z");
  // Starting inside the repeated hour does not run the fold a second time.
  expect(iso(nextCronInstant(daily, "Europe/Athens", at("2026-10-25T01:00:00Z")))).toBe("2026-10-26T01:30:00.000Z");
  // The same expression in another zone has a different UTC instant.
  expect(iso(nextCronInstant(daily, "America/New_York", at("2026-07-12T00:00:00Z")))).toBe("2026-07-12T07:30:00.000Z");
});

test("the latest due instant is bounded by the freshness window", () => {
  const hourly = parseCron("0 * * * *");
  expect(iso(latestCronInstant(hourly, "UTC", at("2026-07-12T00:00:00Z"), at("2026-07-12T05:59:00Z")))).toBe("2026-07-12T05:00:00.000Z");
  expect(latestCronInstant(parseCron("0 0 1 1 *"), "UTC", at("2026-07-11T06:00:00Z"), at("2026-07-12T06:00:00Z"))).toBeNull();
});

test("zones are validated IANA names and instants need Z or a numeric offset", () => {
  expect(canonicalTimeZone("Europe/Athens")).toBe("Europe/Athens");
  expect(canonicalTimeZone("utc")).toBe("UTC");
  for (const bad of ["+02:00", "Mars/Olympus", "", "Europe/Athens\n", 3]) expect(canonicalTimeZone(bad)).toBeNull();
  expect(parseInstant("2026-07-13T07:00:00+03:00")).toBe(at("2026-07-13T04:00:00Z"));
  expect(parseInstant("2026-07-13T04:00Z")).toBe(at("2026-07-13T04:00:00Z"));
  for (const bad of ["2026-07-13T07:00:00", "2026-07-13", "2026-02-30T00:00:00Z", "2026-07-13T24:00:00Z", "tomorrow"]) {
    expect(parseInstant(bad)).toBeNull();
  }
});
