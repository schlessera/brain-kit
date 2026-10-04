import { readFileSync } from "fs";
import { z } from "zod";
import { isMap, isNode, isScalar, parseDocument, type YAMLMap } from "yaml";
import { safeResolve, type ModuleSettings, type ModuleSettingsField, type ModuleSettingsMigrationPlan } from "@schlessera/brain";
import { parseFrontmatter } from "./lib/frontmatter-parse.js";
import { parseScoringConfig, scoreMaxes } from "./score.js";
import { getAdapterOptions } from "./scrape.js";

// Preserve parser input, including numeric coercion, odd match values, both
// forms and unknown keys. The engine remains the final validator; no defaults
// or normalization are applied to the stored scoring source.
const keywords = z.array(z.string()).nullable().optional();
const numeric = z.unknown();
const group = z.looseObject({ name: z.string(), weight: numeric, match: z.unknown().optional(), titleBoost: numeric.optional(), tiers: z.unknown().optional(), keywords });
export const scoringSourceSchema = z.looseObject({
  groups: z.array(group),
  location: z.looseObject({ weight: numeric, preferred: keywords, excluded: keywords }).nullable().optional(),
  excludeTitles: keywords,
  compensationBenchmark: numeric.optional(),
  compensationWeight: numeric.optional(),
  queueThreshold: numeric.optional(),
  dismissThreshold: numeric.optional(),
}).superRefine((source, ctx) => {
  try { parseScoringConfig(source); }
  catch (error) {
    const message = (error as Error).message;
    const found = message.match(/scoring((?:\.[A-Za-z]+|\[\d+\])*)/);
    const path = found?.[1]?.match(/[A-Za-z]+|\d+/g)?.map((p) => /^\d+$/.test(p) ? Number(p) : p) ?? [];
    ctx.addIssue({ code: "custom", path, message });
  }
});

const number = (key: string, label: string, extra: Partial<ModuleSettingsField> = {}): ModuleSettingsField => ({ key, label, kind: "number", unit: "points", ...extra });
const tags = (key: string, label: string, help: string): ModuleSettingsField => ({ key, label, kind: "tags", help });
const tierFields: ModuleSettingsField[] = [number("points", "Points"), tags("keywords", "Keywords", "Matched without regard to case.")];
const groupFields: ModuleSettingsField[] = [
  { key: "name", label: "Name", kind: "text", help: "Shown in each job's score breakdown." },
  number("weight", "Maximum points"),
  { key: "match", label: "Look in", kind: "choice", default: "all", options: [{ value: "all", label: "Title and description" }, { value: "title", label: "Title only" }] },
  number("titleBoost", "Title boost", { unit: "×", step: 0.1, default: 1, help: "Multiplies a tier's points when its keyword is in the title." }),
  { key: "", label: "Scoring style", kind: "variant", variants: [
    { key: "tiers", label: "Graded tiers", fields: [{ key: "tiers", label: "Tiers", kind: "list", itemTitle: "points", orderMatters: true, minItems: 1, addLabel: "Add tier", fields: tierFields, help: "The best matching tier counts, up to the group's maximum." }] },
    { key: "keywords", label: "One keyword list", fields: [tags("keywords", "Keywords", "Any match scores the group's maximum.")] },
  ] },
];

export function jobsSettings<C extends { criteria: string; scoring?: unknown }>(): ModuleSettings<C> {
  return {
    fields: [
      { key: "scoring", label: "Scoring", kind: "record", group: "Scoring", fields: [
        { key: "groups", label: "Scoring groups", kind: "list", itemTitle: "name", collapsible: true, orderMatters: true, minItems: 1, uniqueBy: "name", addLabel: "Add group", fields: groupFields, help: "Each group adds up to its maximum points." },
        { key: "location", label: "Location", kind: "record", optional: { label: "Score location" }, fields: [number("weight", "Points when preferred"), tags("preferred", "Preferred markers", "Whole words, such as remote, europe."), tags("excluded", "Excluded markers", "Any excluded marker scores location zero, even when a preferred marker matches.")] },
        tags("excludeTitles", "Never show titles containing", "A matching title scores zero in every group."),
        number("compensationBenchmark", "Salary benchmark (annual)", { currency: "EUR", unit: "/ year", minorUnits: true, optional: { label: "Score salary" }, help: "Listings are converted to EUR cents with the rates below." }),
        number("compensationWeight", "Points at or above the benchmark", { default: 0, help: "Half at 80% of it; 30% when a listing gives no salary." }),
        number("queueThreshold", "Queue for review at", { default: 60 }),
        number("dismissThreshold", "Dismiss below", { default: 35 }),
      ] },
      { key: "boards", label: "Sources", kind: "multichoice", group: "Sources", options: getAdapterOptions().map((o) => ({ value: o.source, label: o.label, disabled: o.status === "blocked", help: [o.defaultSelected ? "Selected by default" : "Not selected by default", o.usesQueries ? "Uses your queries" : null, o.needsBrowser ? "Needs a browser on the host" : null, o.caveat?.replace(/; see .*$/, "").replace(/client-rendered; needs a browser(?:; )?/, "")].filter(Boolean).join(" · ") })) },
      { key: "queries", label: "Queries", kind: "tags", group: "Sources", help: "Used by SimplyHired and Dice only." },
      { key: "rates", label: "Currency → EUR rates", kind: "weights", group: "Conversion", help: "Overrides the package's built-in rates, which go stale." },
      number("enrichment.maxDetailPages", "Maximum detail pages", { group: "Enrichment", unit: "pages", help: "Zero turns enrichment off." }),
      number("enrichment.concurrency", "Concurrent detail requests", { group: "Enrichment", unit: "requests" }),
      { key: "opportunitiesDir", label: "Opportunity directory", kind: "text", group: "Storage", appliesAt: "restart" },
      { key: "dbPath", label: "Database path", kind: "text", group: "Storage", readOnly: { reason: "set in brain config", whenInherited: true }, help: "Set in brain config when inherited.", appliesAt: "restart" },
      { key: "criteria", label: "Criteria document", kind: "text", group: "Storage", help: "Keeps your criteria prose; legacy scoring remains here until moved." },
    ],
    actions: [{ id: "rescore", label: "Rescore now", help: "Rescore the local queue using saved settings.", command: ["jobs", "score", "--all"], confirm: "Rescore all jobs and update their queue classifications?" }],
    notes(config) {
      if (config.scoring === undefined) return [];
      const parsed = parseScoringConfig(config.scoring);
      const maximum = Object.values(scoreMaxes(parsed)).reduce((sum, v) => sum + v, 0);
      const rawGroups = (config.scoring as { groups: Array<{ tiers?: unknown }> }).groups;
      return [{ key: "scoring.groups", text: `Highest possible score ${maximum}` }, { key: "scoring.dismissThreshold", text: parsed.dismissThreshold > parsed.queueThreshold ? "No score stays pending." : `Jobs scoring at least ${parsed.dismissThreshold} and below ${parsed.queueThreshold} stay pending.` }, ...parsed.groups.flatMap((group, i) => [
        { key: `scoring.groups.${i}`, text: `up to ${group.weight} pts · ${Array.isArray(rawGroups[i]?.tiers) ? `${group.tiers.length} tiers` : "one list"} · ${group.tiers.reduce((n, tier) => n + tier.keywords.length, 0)} keywords` },
        ...group.tiers.flatMap((tier, j) => tier.points > group.weight ? [{ key: `scoring.groups.${i}.tiers.${j}.points`, text: `capped at ${group.weight} by the group` }] : []),
      ])];
    },
    migration: { label: "Move scoring rules", help: "Preview the complete rules before moving them. Your prose and unrelated settings stay in the criteria document.", target: "scoring", plan: planScoringMigration },
  };
}

const MOVED_KEYS = new Set(["groups", "location", "excludeTitles", "compensationBenchmark", "compensationWeight", "queueThreshold", "dismissThreshold"]);

function removalRanges(map: YAMLMap, keys: Set<string>, yaml: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let kept = false;
  for (let i = 0; i < map.items.length; i++) {
    const item = map.items[i]!;
    if (!isScalar(item.key) || !item.key.range) throw new Error("Missing mapping key source range");
    const removing = keys.has(String(item.key.value));
    if (map.flow) {
      // Delete entries and their delimiters, leaving retained values, comments
      // and whitespace verbatim. The first surviving entry has no comma.
      const comma = item.srcToken?.start.find((token) => token.type === "comma");
      if (comma && (removing || !kept)) ranges.push([comma.offset, comma.offset + comma.source.length]);
      if (removing) {
        const end = isNode(item.value) ? item.value.range?.[1] : undefined;
        if (end === undefined) throw new Error("Missing mapping value source range");
        ranges.push([item.key.range[0], end]);
      }
    } else if (removing) {
      const start = yaml.lastIndexOf("\n", item.key.range[0] - 1) + 1;
      // The next key's source line can follow its own comments or blank
      // lines. Stop at this value's span so those unrelated bytes survive.
      const newline = yaml.indexOf("\n", item.key.range[1]);
      const end = isNode(item.value) && item.value.range ? item.value.range[2] : newline < 0 ? yaml.length : newline + 1;
      ranges.push([start, end]);
    }
    if (!removing) kept = true;
  }
  return ranges;
}

/** Remove only known scoring entries by source span; preserve all other bytes. */
export function planScoringMigration(root: string, config: { criteria: string; scoring?: unknown }): ModuleSettingsMigrationPlan {
  const path = safeResolve(root, config.criteria);
  if (!path) throw new Error("Criteria document escapes the brain root; no changes made");
  const before = readFileSync(path, "utf8");
  const original = parseFrontmatter(before);
  const scoring: unknown = original.data.scoring;
  const input = scoring && typeof scoring === "object" && !Array.isArray(scoring) ? scoring as Record<string, unknown> : {};
  const moved = Object.fromEntries(Object.entries(input).filter(([key]) => MOVED_KEYS.has(key)));
  if (config.scoring !== undefined) {
    if (!Object.keys(moved).length) return { values: {}, changes: [], details: { alreadyMoved: true, source: config.criteria } };
    throw new Error("Saved scoring already exists; review it before migrating legacy rules");
  }
  const parsed = parseScoringConfig(scoring);
  // Use the parser's exact source block, including its accepted BOM, CRLF,
  // language tag and missing closing delimiter forms. YAML also parses JSON
  // flow mappings; executable JavaScript has no lossless mapping source spans.
  if (!["yaml", "json"].includes(original.language)) throw new Error("Migration requires YAML or JSON frontmatter; no changes made");
  const yaml = original.matter;
  const offset = before.indexOf(yaml, (before.startsWith("\uFEFF") ? 1 : 0) + 3);
  if (!yaml || offset < 0) throw new Error("Cannot locate frontmatter source; no changes made");
  // gray-matter leaves the closing line's CR in its block. Complete that
  // newline for the source-span parser without changing existing offsets.
  const document = parseDocument(yaml.endsWith("\r") ? yaml + "\n" : yaml, { version: "1.1", keepSourceTokens: true });
  if (document.errors.length || !isMap(document.contents)) throw new Error("Cannot identify scoring source ranges; no changes made");
  const pair = document.contents.items.find((p) => isScalar(p.key) && p.key.value === "scoring");
  if (!pair || !isMap(pair.value)) throw new Error("Scoring must be a mapping; no changes made");
  const ranges = Object.keys(input).every((key) => MOVED_KEYS.has(key))
    ? removalRanges(document.contents, new Set(["scoring"]), yaml)
    : removalRanges(pair.value, MOVED_KEYS, yaml);
  let after = before;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) after = after.slice(0, offset + start) + after.slice(offset + Math.min(end, yaml.length));
  const remaining = parseFrontmatter(after);
  const retained = remaining.data.scoring && typeof remaining.data.scoring === "object" ? remaining.data.scoring : {};
  const jsonMoved = JSON.parse(JSON.stringify(moved)) as Record<string, unknown>;
  const restored = { ...retained, ...jsonMoved };
  const unchangedData = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([key]) => key !== "scoring"));
  if (JSON.stringify(parseScoringConfig(restored)) !== JSON.stringify(parsed) || JSON.stringify(unchangedData(original.data)) !== JSON.stringify(unchangedData(remaining.data)) || original.content !== remaining.content || JSON.stringify(jsonMoved) !== JSON.stringify(moved)) {
    throw new Error("Migration could not prove source preservation and identical scoring; no changes made");
  }
  return {
    values: { scoring: jsonMoved }, changes: [{ path: config.criteria, before, after }],
    details: { source: config.criteria, summary: `${parsed.groups.length} groups and ${parsed.groups.reduce((n, group) => n + group.tiers.length, 0)} tiers carried over. The parsed scoring rules are identical before and after the move.`, original: scoring, moved: jsonMoved, retained, parserEquivalent: true, maxes: scoreMaxes(parsed), warnings: Object.keys(retained).length ? ["Unknown scoring keys stay in the criteria document."] : [] },
  };
}
