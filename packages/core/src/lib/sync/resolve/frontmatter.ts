/**
 * Three-way merge of a document's frontmatter, field by field.
 *
 * A field only one side changed takes that side (a removal included). A field
 * both sides changed follows its rule: `updated` the later date, `created` the
 * earlier, `tags` the union, anything else OURS (so `status` is THEIRS only
 * when OURS left it as it was, which the one-side rule already covers). A field removed on one side
 * and changed on the other is kept, because content wins. The result is OURS'
 * block edited in place (`editFrontmatter`), so its key order, quoting and
 * comments survive; only a value that edit cannot write sends the block
 * through the serializer.
 */

import { stringifyDocument } from "../../frontmatter.js";
import { editFrontmatter, type FrontmatterValue } from "../../frontmatter-edit.js";
import { frontmatterLength } from "../../document-parts.js";
import type { Doc } from "./markdown.js";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A frontmatter date as a point in time: a YAML date, or a string holding an
 * ISO date with an optional time. Anything else is null, so `2026-02-30` or
 * `last week` never outranks a real date.
 */
export function dateValue(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== "string") return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const day = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(m) - 1 || day.getUTCDate() !== Number(d)) {
    return null;
  }
  const time = Date.parse(value.trim().replace(" ", "T"));
  return Number.isNaN(time) ? null : time;
}

/**
 * A value as comparison sees it: a date and the string it prints as are the
 * same value. `.nan` and `.inf` keep their names, which JSON would print as
 * `null`. The walk recurses: `parseDoc` has refused a value that refers to
 * itself or nests too deeply.
 */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v instanceof Date) return { $date: v.toISOString().replace("T00:00:00.000Z", "") };
    if (typeof v === "number" && !Number.isFinite(v)) return { $number: String(v) };
    if (typeof v === "string" && dateValue(v) !== null && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return { $date: v.trim() };
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return value === undefined ? "\u0000absent" : JSON.stringify(walk(value));
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** A tag list as strings: a lone string is a list of one. */
function tagList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((v) => typeof v === "string" || typeof v === "number")) return null;
  return list.map(String);
}

/** A value `editFrontmatter` can write, or undefined when it cannot. */
function writable(value: unknown): FrontmatterValue | undefined {
  if (value instanceof Date) return value.toISOString().replace("T00:00:00.000Z", "");
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return undefined;
}

const ABSENT = Symbol("absent");

/**
 * The merged frontmatter block, with its fences and closing line ending, or
 * "" when no field survives. `notes` gains one line per field both sides
 * changed and per field kept over a removal.
 */
export function mergeFrontmatter(base: Doc, ours: Doc, theirs: Doc, notes: string[]): string {
  // The block as a whole first: one side left it alone, so the other's bytes stand.
  if (ours.frontmatter === theirs.frontmatter || theirs.frontmatter === base.frontmatter) return ours.frontmatter;
  if (ours.frontmatter === base.frontmatter) return theirs.frontmatter;

  const has = (doc: Doc, key: string) => Object.prototype.hasOwnProperty.call(doc.data, key);
  const keys = [...new Set([...Object.keys(ours.data), ...Object.keys(theirs.data), ...Object.keys(base.data)])];
  const merged = new Map<string, unknown>();
  for (const key of keys) {
    const b = has(base, key) ? base.data[key] : undefined;
    const o = has(ours, key) ? ours.data[key] : undefined;
    const t = has(theirs, key) ? theirs.data[key] : undefined;
    let value: unknown;
    if (same(o, t) || same(t, b)) value = o;
    else if (same(o, b)) value = t;
    else if (o === undefined || t === undefined) {
      value = o !== undefined ? o : t;
      notes.push(`frontmatter \`${key}\`: removed on ${o === undefined ? "our" : "their"} side and changed on the other; kept the changed value`);
    } else value = bothChanged(key, o, t, notes);
    merged.set(key, value === undefined ? ABSENT : value);
  }

  const updates: Record<string, FrontmatterValue> = {};
  let editable = ours.frontmatter !== "";
  for (const [key, value] of merged) {
    const current = has(ours, key) ? ours.data[key] : undefined;
    if (value === ABSENT) {
      if (has(ours, key)) updates[key] = null;
      continue;
    }
    if (has(ours, key) && same(current, value)) continue;
    const text = writable(value);
    if (text === undefined) editable = false;
    else updates[key] = text;
  }
  if (editable && Object.keys(updates).length === 0) return ours.frontmatter;
  if (editable) {
    const edited = editFrontmatter(ours.frontmatter, updates);
    if (edited !== null) return edited;
  }

  // A value the in-place edit cannot write (a number, a map, a YAML null):
  // serialize, in OURS' key order, then the keys only THEIRS has.
  const data: Record<string, unknown> = {};
  for (const [key, value] of merged) if (value !== ABSENT) data[key] = value;
  if (Object.keys(data).length === 0) return "";
  notes.push("frontmatter: rewritten by the serializer; quoting and comments may differ from ours");
  const text = stringifyDocument("", data);
  return text.slice(0, frontmatterLength(text));
}

function bothChanged(key: string, o: unknown, t: unknown, notes: string[]): unknown {
  if (key === "updated" || key === "created") {
    const later = key === "updated";
    const ot = dateValue(o);
    const tt = dateValue(t);
    if (ot === null || tt === null) {
      notes.push(`frontmatter \`${key}\`: both sides changed it and one is not a date; kept ours`);
      return o;
    }
    const takeTheirs = later ? tt > ot : tt < ot;
    notes.push(`frontmatter \`${key}\`: both sides changed it; kept the ${later ? "later" : "earlier"} (${takeTheirs ? "theirs" : "ours"})`);
    return takeTheirs ? t : o;
  }
  if (key === "tags") {
    const a = tagList(o);
    const b = tagList(t);
    if (a && b) {
      notes.push("frontmatter `tags`: both sides changed them; kept the union");
      return [...new Set([...a, ...b])].sort();
    }
  }
  notes.push(`frontmatter \`${key}\`: both sides changed it; kept ours`);
  return o;
}
