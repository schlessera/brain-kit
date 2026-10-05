/**
 * Schedule time rules (Timing A, docs/decisions/scheduled-tasks.md): IANA
 * zones, offset/Z one-off instants and the five-field numeric cron grammar.
 *
 * Due computation runs over local wall-clock minutes in the task's own zone.
 * A wall time that does not exist (a DST gap) is skipped; a wall time that
 * occurs twice (a DST fold) maps to its earlier UTC instant only, so it runs
 * once. Every search is bounded and deterministic.
 */

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Longest gap between two matches of a possible expression: Feb 29 recurs within 8 years. */
const SEARCH_DAYS = 8 * 366 + 2;

export class ScheduleTimeError extends Error {}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(zone, format);
  }
  return format;
}

/** The validated canonical IANA name, or null. Numeric offsets are not zones. */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || !ZONE_NAME.test(value)) return null;
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return ZONE_NAME.test(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Parse an ISO instant that carries `Z` or a numeric offset; returns UTC ms. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0", , zone] = match;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== "Z") {
    const offsetHours = Number(zone!.slice(1, 3)), offsetMinutes = Number(zone!.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
  }
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) ? ms : null;
}

export function isoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number }

function wallOf(zone: string, ms: number): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

function wallMs(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/**
 * The earliest UTC instant showing this local wall time in the zone, or null
 * when the wall time falls in a gap. A fold has two instants; the earlier wins.
 */
export function wallTimeInstant(zone: string, year: number, month: number, day: number, hour: number, minute: number): number | null {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = new Set<number>();
  for (const probe of [target - DAY_MS, target, target + DAY_MS]) {
    const offset = wallMs(wallOf(zone, probe)) - probe;
    const instant = target - offset;
    if (wallMs(wallOf(zone, instant)) === target) candidates.add(instant);
  }
  return candidates.size === 0 ? null : Math.min(...candidates);
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export interface CronSpec {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Either day field begins with `*`: both day predicates must then match. */
  dayStar: boolean;
}

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;
const NUMBER = /^(0|[1-9][0-9]{0,1})$/;

function parseField(text: string, { min, max }: { min: number; max: number }): Set<number> {
  const values = new Set<number>();
  if (text.length === 0) throw new ScheduleTimeError("Empty cron field");
  for (const element of text.split(",")) {
    const [range, step, extra] = element.split("/");
    if (extra !== undefined || range === undefined) throw new ScheduleTimeError("Invalid cron step");
    let from: number, to: number;
    if (range === "*") {
      from = min; to = max;
    } else {
      const [a, b, more] = range.split("-");
      if (more !== undefined || a === undefined || !NUMBER.test(a) || (b !== undefined && !NUMBER.test(b)))
        throw new ScheduleTimeError("Invalid cron value");
      from = Number(a); to = b === undefined ? from : Number(b);
      // A stepped single value (`5/10`) is a cronie extension; reject it.
      if (step !== undefined && b === undefined) throw new ScheduleTimeError("Invalid cron step");
    }
    if (from < min || to > max || from > to) throw new ScheduleTimeError("Cron value out of range");
    let increment = 1;
    if (step !== undefined) {
      if (!NUMBER.test(step) || Number(step) < 1) throw new ScheduleTimeError("Invalid cron step");
      increment = Number(step);
    }
    for (let value = from; value <= to; value += increment) values.add(value);
  }
  return values;
}

/** Parse the record's numeric five-field grammar; throws ScheduleTimeError. */
export function parseCron(expression: unknown): CronSpec {
  if (typeof expression !== "string" || expression.length === 0 || Buffer.byteLength(expression) > 128)
    throw new ScheduleTimeError("Cron expression must be 1–128 bytes");
  if (!/^[0-9*,/ -]+$/.test(expression)) throw new ScheduleTimeError("Cron expression uses unsupported characters");
  const fields = expression.split(" ");
  if (fields.length !== 5) throw new ScheduleTimeError("Cron expression needs exactly five single-space-separated fields");
  const [minute, hour, day, month, weekday] = fields.map((field, index) => parseField(field, FIELDS[index]!));
  const weekdays = new Set([...weekday!].map((value) => value % 7));
  const spec: CronSpec = {
    minutes: [...minute!].sort((a, b) => a - b),
    hours: [...hour!].sort((a, b) => a - b),
    days: day!, months: month!, weekdays,
    dayStar: fields[2]!.startsWith("*") || fields[4]!.startsWith("*"),
  };
  if (!possible(spec)) throw new ScheduleTimeError("Cron expression can never match");
  return spec;
}

function possible(spec: CronSpec): boolean {
  // Without the day-of-month restriction every month has every weekday.
  if (!spec.dayStar) return true;
  return [...spec.months].some((month) => [...spec.days].some((day) => day <= (month === 2 ? 29 : daysInMonth(2001, month))));
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dom = spec.days.has(day), dow = spec.weekdays.has(weekday);
  return spec.dayStar ? dom && dow : dom || dow;
}

/** Local calendar days, walking forward or backward from the zone's date at `ms`. */
function* localDays(zone: string, ms: number, direction: 1 | -1): Generator<{ year: number; month: number; day: number }> {
  const start = wallOf(zone, ms);
  let cursor = Date.UTC(start.year, start.month - 1, start.day) - direction * DAY_MS;
  for (let i = 0; i < SEARCH_DAYS; i++, cursor += direction * DAY_MS) {
    const date = new Date(cursor);
    yield { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
}

function dayInstants(spec: CronSpec, zone: string, date: { year: number; month: number; day: number }): number[] {
  if (!dayMatches(spec, date.year, date.month, date.day)) return [];
  const instants: number[] = [];
  for (const hour of spec.hours) {
    for (const minute of spec.minutes) {
      const instant = wallTimeInstant(zone, date.year, date.month, date.day, hour, minute);
      if (instant !== null) instants.push(instant);
    }
  }
  return [...new Set(instants)].sort((a, b) => a - b);
}

/** First due instant strictly after `afterMs`, or null within the bounded search. */
export function nextCronInstant(spec: CronSpec, zone: string, afterMs: number): number | null {
  for (const date of localDays(zone, afterMs, 1)) {
    const found = dayInstants(spec, zone, date).find((instant) => instant > afterMs);
    if (found !== undefined) return found;
  }
  return null;
}

/** Latest due instant in `[notBeforeMs, atMs]`, or null. */
export function latestCronInstant(spec: CronSpec, zone: string, notBeforeMs: number, atMs: number): number | null {
  for (const date of localDays(zone, atMs, -1)) {
    const instants = dayInstants(spec, zone, date).filter((instant) => instant <= atMs);
    const found = instants.at(-1);
    if (found !== undefined) return found >= notBeforeMs ? found : null;
    // Days before the window cannot contain a later instant.
    if (Date.UTC(date.year, date.month - 1, date.day) + 2 * DAY_MS < notBeforeMs) return null;
  }
  return null;
}

/** All due instants in `[fromMs, toMs]`, ascending (bounded by the search horizon). */
export function cronInstantsBetween(spec: CronSpec, zone: string, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (const date of localDays(zone, fromMs, 1)) {
    if (Date.UTC(date.year, date.month - 1, date.day) - 2 * DAY_MS > toMs) break;
    for (const instant of dayInstants(spec, zone, date)) if (instant >= fromMs && instant <= toMs) out.push(instant);
  }
  return out;
}

export const SCHEDULE_FRESHNESS_MS = DAY_MS;
export { MINUTE_MS };
