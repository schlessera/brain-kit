import { z } from "zod";
import yaml from "js-yaml";
import { readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { repoRelativePathSchema } from "@schlessera/brain";
import { buildTaxonomy, getMarkdownFiles, safeResolve } from "@schlessera/brain/internal";
import type { Taxonomy } from "@schlessera/brain";
import type { ValidationIssue } from "@schlessera/brain/internal";
import { parseFrontmatter } from "./lib/frontmatter-parse.js";

function parseYaml(text: string): object {
  const data = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Travel frontmatter must be an object");
  }
  return data;
}

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const documentReference = repoRelativePathSchema.refine((path) => path.endsWith(".md"), "use the complete root-relative .md path");
const assetReference = z.string().min(1).refine((path) =>
  !path.startsWith("/") && !path.startsWith("~") && !path.includes("\\") &&
  !/[\u0000-\u001f\u007f]/.test(path), "use a document-relative asset path");
const day = z.preprocess((value) => value instanceof Date ? value.toISOString().slice(0, 10) : value,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "use a real calendar date"));
const unknownDay = day.nullable().optional();
const metric = z.number().finite().nonnegative().nullable().optional();

export const routeSchema = z.object({
  label: z.string().min(1),
  source: z.string().min(1).nullable().optional(),
  kind: z.enum(["planned", "recorded", "reference"]),
  url: z.url().refine((value) => /^https?:\/\//.test(value), "use an HTTP(S) route URL").optional(),
  gpx: assetReference.optional(),
  distance_km: metric,
  ascent_m: metric,
  primary: z.boolean().optional(),
}).passthrough();

export const visitSchema = z.object({
  id,
  date: unknownDay,
  party: z.array(z.string()).nullable().optional(),
  route: z.string().min(1).nullable().optional(),
  track: assetReference.optional(),
  actual: z.object({ distance_km: metric, ascent_m: metric, duration_s: metric }).passthrough().nullable().optional(),
  verdict: z.string().optional(),
  photos: z.array(assetReference).optional(),
  places: z.array(documentReference).optional(),
}).passthrough();

const common = { title: z.string().min(1), places: z.array(documentReference).optional() };
export const journeySchema = z.object({
  ...common, type: z.literal("travel"), visits: z.array(visitSchema).optional(),
}).passthrough();
export const tripSchema = z.object({
  ...common, type: z.literal("trip"), trip_status: z.enum(["proposed", "done", "dismissed"]),
  visits: z.array(visitSchema).optional(), routes: z.array(routeSchema).optional(),
  cover: assetReference.optional(),
}).passthrough();
export const placeSchema = z.object({
  title: z.string().min(1), type: z.literal("place"),
  place_kind: z.enum(["country", "city", "town", "spot"]),
  parent_place: documentReference.nullable().optional(),
  coordinates: z.object({ lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180) }).strict().nullable().optional(),
  visits: z.array(z.object({ document: documentReference, visit: id }).strict()).optional(),
  // Optional rendered cache only. Summaries always derive from canonical visits.
  first_visit: unknownDay, last_visit: unknownDay,
  visit_count: z.number().int().nonnegative().optional(),
}).passthrough();

export type Journey = z.infer<typeof journeySchema>;
export type Trip = z.infer<typeof tripSchema>;
export type Place = z.infer<typeof placeSchema>;
export type TravelDocument = Journey | Trip | Place;

export function parseTravelDocument(source: string): TravelDocument {
  // Keep written calendar days as strings: YAML timestamp coercion can turn
  // an impossible date into a different real day before validation.
  const raw = parseFrontmatter(source, { engines: { yaml: parseYaml } }).data;
  const data = raw.type === "travel" ? journeySchema.parse(raw)
    : raw.type === "trip" ? tripSchema.parse(raw) : placeSchema.parse(raw);
  if (data.type === "place") return data;
  const visits = data.visits ?? [];
  if (new Set(visits.map((visit) => visit.id)).size !== visits.length) throw new Error("Duplicate visit id in one document");
  if (data.type === "trip") {
    if (data.trip_status === "done" && !visits.length) throw new Error("A done trip needs at least one visit, with an unknown date if necessary");
    const routes = data.routes ?? [];
    if (new Set(routes.map((route) => route.label)).size !== routes.length) throw new Error("Duplicate route label in one trip");
    if (routes.length && routes.filter((route) => route.primary === true).length !== 1) throw new Error("Exactly one route must be primary");
    for (const visit of visits) {
      if (visit.route && !routes.some((route) => route.label === visit.route)) throw new Error(`Visit ${visit.id} names an unknown route: ${visit.route}`);
    }
  }
  return data;
}

export interface TravelCorpus {
  documents: Map<string, TravelDocument>;
  issues: ValidationIssue[];
}

/** Read canonical files; no index/database write or stored aggregate is trusted. */
export function readTravelCorpus(root: string, taxonomy: Taxonomy = buildTaxonomy({})): TravelCorpus {
  const documents = new Map<string, TravelDocument>();
  const issues: ValidationIssue[] = [];
  const error = (file: string, message: string): void => { issues.push({ file, level: "error", message }); };
  for (const path of getMarkdownFiles(root, taxonomy)) {
    try {
      const source = readFileSync(join(root, path), "utf8");
      const type = parseFrontmatter(source).data.type;
      if (type !== "travel" && type !== "trip" && type !== "place") continue;
      documents.set(path, parseTravelDocument(source));
    } catch (cause) { error(path, (cause as Error).message); }
  }
  const placeTarget = (path: string, target: string): void => {
    if (documents.get(target)?.type !== "place") error(path, `Unknown place reference: ${target}`);
  };
  const asset = (path: string, target: string): void => {
    const resolved = safeResolve(root, join(dirname(path), target));
    try {
      if (!resolved || !statSync(resolved).isFile()) error(path, `Missing or escaping asset reference: ${target}`);
    } catch { error(path, `Missing asset reference: ${target}`); }
  };
  for (const [path, data] of documents) {
    if (data.type === "place") {
      if (data.parent_place) {
        placeTarget(path, data.parent_place);
        const parent = documents.get(data.parent_place);
        if (parent?.type === "place" && (data.place_kind === "country" || parent.place_kind === "spot" ||
          ((data.place_kind === "city" || data.place_kind === "town") && parent.place_kind !== "country"))) {
          error(path, "Place hierarchy must run from country to city/town to spot");
        }
      }
      for (const reference of data.visits ?? []) {
        const owner = documents.get(reference.document);
        if (!owner || owner.type === "place" || !owner.visits?.some((visit) => visit.id === reference.visit)) {
          error(path, `Unknown visit reference: ${reference.document}#${reference.visit}`);
        }
      }
      continue;
    }
    for (const target of data.places ?? []) placeTarget(path, target);
    for (const visit of data.visits ?? []) {
      for (const target of visit.places ?? []) placeTarget(path, target);
      if (visit.track) asset(path, visit.track);
      for (const photo of visit.photos ?? []) asset(path, photo);
    }
    if (data.type === "trip") {
      if (data.cover) asset(path, data.cover);
      for (const route of data.routes ?? []) if (route.gpx) asset(path, route.gpx);
    }
  }
  for (const [path, data] of documents) {
    if (data.type !== "place") continue;
    const seen = new Set<string>([path]);
    let parent = data.parent_place;
    while (parent) {
      if (seen.has(parent)) { error(path, "Place hierarchy contains a cycle"); break; }
      seen.add(parent);
      const target = documents.get(parent);
      parent = target?.type === "place" ? target.parent_place : null;
    }
  }
  return { documents, issues };
}

export interface PlaceVisitSummary {
  path: string;
  visit_count: number;
  first_visit: string | null;
  last_visit: string | null;
  visits: { document: string; visit: string; date: string | null }[];
}

/** One event per document path + visit id, regardless of duplicate references. */
export function summarizePlaceVisits(corpus: TravelCorpus, path: string): PlaceVisitSummary {
  const place = corpus.documents.get(path);
  if (!place || place.type !== "place") throw new Error(`Not a place: ${path}`);
  const references = new Map<string, { document: string; visit: string; date: string | null }>();
  const add = (document: string, visitId: string): void => {
    const owner = corpus.documents.get(document);
    if (!owner || owner.type === "place") return;
    const visit = owner.visits?.find((entry) => entry.id === visitId);
    if (visit) references.set(JSON.stringify([document, visitId]), { document, visit: visitId, date: visit.date ?? null });
  };
  for (const reference of place.visits ?? []) add(reference.document, reference.visit);
  for (const [document, owner] of corpus.documents) {
    if (owner.type === "place") continue;
    for (const visit of owner.visits ?? []) {
      if (owner.places?.includes(path) || visit.places?.includes(path)) add(document, visit.id);
    }
  }
  const visits = [...references.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
  const dates = visits.flatMap((visit) => visit.date ? [visit.date] : []).sort();
  const allDatesKnown = visits.every((visit) => visit.date !== null);
  return { path, visit_count: visits.length,
    first_visit: allDatesKnown ? dates[0] ?? null : null,
    last_visit: allDatesKnown ? dates.at(-1) ?? null : null, visits };
}
