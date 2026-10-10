import { lstatSync, readFileSync } from "fs";
import { join, posix } from "path";
import { inertGeneratedText, rewriteGeneratedRegion, safeResolve, writeFileSafely } from "@schlessera/brain/internal";
import type { Taxonomy } from "@schlessera/brain";
import type { ValidationIssue } from "@schlessera/brain/internal";
import { readTravelCorpus, summarizePlaceVisits } from "./content.js";
import type { Place, Trip, TravelCorpus } from "./content.js";

// The registries live in core's generated regions, named apart from the
// `registry` region `brain registry` owns, so both can share one _index.md.
export const TRIPS_REGION = "travel-trips";
export const PLACES_REGION = "travel-places";

type Visit = { document: string; visit: string; date: string | null };

/** Root-relative paths sort by code unit, never by locale. */
const byPath = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

const text = (value: string): string => inertGeneratedText(value).replace(/([[\]])/g, "\\$1");

function link(indexPath: string, target: string, title: string): string {
  const relative = posix.relative(posix.dirname(indexPath), target);
  // encodeURIComponent leaves parentheses, which would end the destination early.
  const destination = relative.split("/").map((part) => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29"));
  return `[${text(title)}](${destination.join("/")})`;
}

const show = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "unknown" : text(String(value));

/** First/last are known only when every included visit has a date (the place rule). */
function bounds(visits: { date: string | null }[]): { first: string | null; last: string | null } {
  if (!visits.length || visits.some((visit) => visit.date === null)) return { first: null, last: null };
  const dates = visits.map((visit) => visit.date as string).sort();
  return { first: dates[0], last: dates.at(-1) as string };
}

function table(header: string[], rows: string[][]): string {
  if (!rows.length) return "_None._";
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function tripPlaces(trip: Trip): string[] {
  const places = new Set(trip.places ?? []);
  for (const visit of trip.visits ?? []) for (const place of visit.places ?? []) places.add(place);
  return [...places].sort(byPath);
}

export function renderTrips(corpus: TravelCorpus, indexPath: string): string {
  const trips = [...corpus.documents].filter((entry): entry is [string, Trip] => entry[1].type === "trip")
    .sort(([a], [b]) => byPath(a, b));
  const placeLinks = (trip: Trip): string => {
    const places = tripPlaces(trip);
    return places.length ? places.map((path) => link(indexPath, path, corpus.documents.get(path)?.title ?? path)).join(", ") : "—";
  };
  const primary = (trip: Trip) => (trip.routes ?? []).find((route) => route.primary === true);
  const route = (trip: Trip): string[] => {
    const chosen = primary(trip);
    return chosen ? [text(chosen.label), show(chosen.distance_km), show(chosen.ascent_m)] : ["—", "—", "—"];
  };
  const of = (status: Trip["trip_status"]) => trips.filter(([, trip]) => trip.trip_status === status);
  const done = of("done").map(([path, trip]) => {
    const { first, last } = bounds((trip.visits ?? []).map((visit) => ({ date: visit.date ?? null })));
    return [link(indexPath, path, trip.title), String(trip.visits?.length ?? 0), show(first), show(last), ...route(trip), placeLinks(trip)];
  });
  const proposed = of("proposed").map(([path, trip]) => [link(indexPath, path, trip.title), ...route(trip), placeLinks(trip)]);
  const dismissed = of("dismissed").map(([path, trip]) => [link(indexPath, path, trip.title), String(trip.visits?.length ?? 0)]);
  return [
    "_Generated from each trip's frontmatter by `brain travel sync`. Edit the trips, not these tables._",
    "",
    "### Done",
    "",
    table(["Trip", "Visits", "First", "Last", "Primary route", "Distance (km)", "Ascent (m)", "Places"], done),
    "",
    "### Proposed",
    "",
    table(["Trip", "Primary route", "Distance (km)", "Ascent (m)", "Places"], proposed),
    "",
    "### Dismissed",
    "",
    table(["Trip", "Visits"], dismissed),
  ].join("\n");
}

export function renderPlaces(corpus: TravelCorpus, indexPath: string): string {
  const places = [...corpus.documents].filter((entry): entry is [string, Place] => entry[1].type === "place")
    .sort(([a], [b]) => byPath(a, b));
  const summaries = new Map(places.map(([path]) => [path, summarizePlaceVisits(corpus, path)]));
  const title = (path: string): string => corpus.documents.get(path)?.title ?? path;

  // A country's rollup is the union of its own and its descendants' canonical
  // visits, deduplicated by the owning document path and visit ID.
  const countryOf = (path: string): string | null => {
    const seen = new Set<string>();
    for (let at: string | null | undefined = path; at && !seen.has(at); ) {
      seen.add(at);
      const place = corpus.documents.get(at);
      if (place?.type !== "place") return null;
      if (place.place_kind === "country") return at;
      at = place.parent_place;
    }
    return null;
  };
  const countries = new Map<string, Map<string, Visit>>();
  for (const [path, summary] of summaries) {
    const country = countryOf(path);
    if (!country) continue;
    const visits = countries.get(country) ?? new Map<string, Visit>();
    for (const visit of summary.visits) visits.set(JSON.stringify([visit.document, visit.visit]), visit);
    countries.set(country, visits);
  }
  const countryRows = [...countries].filter(([, visits]) => visits.size > 0).sort(([a], [b]) => byPath(a, b))
    .map(([path, visits]) => {
      const { first, last } = bounds([...visits.values()]);
      return [link(indexPath, path, title(path)), String(visits.size), show(first), show(last)];
    });

  const placeRows = places.map(([path, place]) => {
    const summary = summaries.get(path)!;
    const coordinates = place.coordinates ? `${place.coordinates.lat}, ${place.coordinates.lon}` : null;
    const parent = place.parent_place ? link(indexPath, place.parent_place, title(place.parent_place)) : "—";
    return [link(indexPath, path, place.title), place.place_kind, parent, String(summary.visit_count),
      show(summary.first_visit), show(summary.last_visit), show(coordinates)];
  });

  // Per year: each place once, with its distinct canonical visits that year.
  const years = new Map<string, Map<string, number>>();
  for (const [path, summary] of summaries) {
    for (const visit of summary.visits) {
      const year = visit.date ? visit.date.slice(0, 4) : "Unknown date";
      const counts = years.get(year) ?? new Map<string, number>();
      counts.set(path, (counts.get(path) ?? 0) + 1);
      years.set(year, counts);
    }
  }
  const yearKeys = [...years.keys()].filter((year) => year !== "Unknown date").sort().reverse();
  if (years.has("Unknown date")) yearKeys.push("Unknown date");
  const yearSections = yearKeys.flatMap((year) => [
    "", `#### ${year}`, "",
    table(["Place", "Visits"], [...years.get(year)!].sort(([a], [b]) => byPath(a, b))
      .map(([path, count]) => [link(indexPath, path, title(path)), String(count)])),
  ]);

  return [
    "_Generated from canonical journey, trip and place records by `brain travel sync`. Edit those records, not these tables._",
    "",
    "### Countries visited",
    "",
    "Each country counts its own visits and those of the places within it, once per visit.",
    "",
    table(["Country", "Visits", "First", "Last"], countryRows),
    "",
    "### Places",
    "",
    "Visits are each place's own canonical visits; dates stay unknown when any of its visits is undated.",
    "",
    table(["Place", "Kind", "Within", "Visits", "First", "Last", "Coordinates"], placeRows),
    "",
    "### By year",
    ...(yearSections.length ? yearSections : ["", "_None._"]),
  ].join("\n");
}

/** A new registry: core index frontmatter, a heading and, for trips, the choosing rules. */
function scaffold(kind: "trips" | "places", asOf: string): string {
  const trips = kind === "trips";
  const title = trips ? "Trips" : "Places";
  const summary = trips
    ? "Day trips: done, proposed and dismissed, with the rules for choosing the next one"
    : "Visited countries, cities, towns and spots, with per-year rollups";
  const rules = trips
    ? "\n## Choosing rules\n\nRules learned from visit verdicts. The trip-log skill proposes them; keep only the ones you agree with.\n"
    : "";
  return `---\ntype: index\ntitle: ${title}\ncreated: ${asOf}\nupdated: ${asOf}\ntags: [index, travel, ${kind}]\n` +
    `status: active\nrelevance: primary\nsummary: "${summary}"\n---\n\n# ${title}\n${rules}`;
}

export interface TravelSyncFile {
  path: string;
  created: boolean;
  /** Content to write; null when the region is current. */
  next: string | null;
  raw: string | null;
}

export interface TravelSyncPlan {
  issues: ValidationIssue[];
  files: TravelSyncFile[];
}

/**
 * Plan both registries without writing. Invalid canonical records or malformed
 * region markers yield issues; the caller writes nothing unless there are none.
 */
export function planTravelSync(root: string, taxonomy: Taxonomy, asOf: string): TravelSyncPlan {
  const corpus = readTravelCorpus(root, taxonomy);
  if (corpus.issues.length) return { issues: corpus.issues, files: [] };
  const files: TravelSyncFile[] = [];
  const issues: ValidationIssue[] = [];
  for (const [type, kind, region, render] of [
    ["trip", "trips", TRIPS_REGION, renderTrips],
    ["place", "places", PLACES_REGION, renderPlaces],
  ] as const) {
    const dir = taxonomy.types[type]?.dir ?? kind;
    const path = posix.join(dir, "_index.md");
    // Two types sharing a directory would plan two writes to one file.
    if (files.some((file) => file.path === path) || issues.some((issue) => issue.file === path)) {
      issues.push({ file: path, level: "error", message: "Trips and places share one registry directory; give the trip and place types separate directories" });
      continue;
    }
    // safeResolve follows a final symlink; a registry must be the file itself.
    if (lstatSync(join(root, path), { throwIfNoEntry: false })?.isSymbolicLink()) {
      issues.push({ file: path, level: "error", message: "Registry is a symlink; refusing to write through it" });
      continue;
    }
    const abs = safeResolve(root, path);
    if (!abs) { issues.push({ file: path, level: "error", message: "Registry path escapes the brain root" }); continue; }
    let raw: string | null = null;
    try { raw = readFileSync(abs, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { issues.push({ file: path, level: "error", message: (error as Error).message }); continue; }
    }
    try {
      const next = rewriteGeneratedRegion(raw ?? scaffold(kind, asOf), region, render(corpus, path), asOf);
      files.push({ path, created: raw === null, raw, next });
    } catch (error) { issues.push({ file: path, level: "error", message: (error as Error).message }); }
  }
  return { issues, files };
}

/**
 * Write every planned change. A registry edited, created or replaced by a
 * symlink since planning refuses the run before its first write; an edit that
 * lands between that check and the write is not detected (path-based writes).
 */
export function applyTravelSync(root: string, plan: TravelSyncPlan): string[] {
  const changed = plan.files.filter((file) => file.next !== null);
  for (const file of changed) {
    const abs = safeResolve(root, file.path);
    let current: string | null = null;
    try { current = abs ? readFileSync(abs, "utf8") : null; } catch { current = null; }
    if (!abs || lstatSync(join(root, file.path), { throwIfNoEntry: false })?.isSymbolicLink() || current !== file.raw) throw new Error(`${file.path} changed during sync; nothing written. Run the sync again.`);
  }
  for (const file of changed) writeFileSafely(safeResolve(root, file.path)!, file.next as string, { replace: !file.created });
  return changed.map((file) => file.path);
}
