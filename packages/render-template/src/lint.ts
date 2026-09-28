import { ACCENTS, DOCUMENT_CLASSES, OPENER_CLASSES } from "./components.js";
import { attribute, classList, cssFetches, documentParts, elements, isElement, parseDocument, textOf } from "./html.js";

/**
 * Something in a built document that will not render the way its author
 * meant. `code` is stable, `message` says what to do about it.
 */
export interface DocumentWarning {
  code:
    | "unknown-class"
    | "unknown-accent"
    | "opener-not-first"
    | "several-openers"
    | "placeholder-image"
    | "remote-image"
    | "empty-link"
    | "script"
    | "network-resource";
  message: string;
}

const KNOWN = new Set(DOCUMENT_CLASSES);
/** Elements that fetch what their src or href names. */
const FETCHING = new Set(["video", "audio", "source", "track", "image", "use", "input"]);
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fetchesRemote(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v !== "" && !/^(?:data:|#)/i.test(v);
}

/** The known classes an unknown `doc-*` class was probably meant to be. */
function suggestions(cls: string): string[] {
  const base = cls.split("--")[0];
  const near = DOCUMENT_CLASSES.filter((k) => k === base || k.startsWith(`${base}--`));
  return near.length > 0 ? near : DOCUMENT_CLASSES.filter((k) => k.startsWith(cls.slice(0, 6)));
}

/**
 * Check a document built by `buildHtmlDocument` for what the renderer will
 * silently get wrong: a misspelt component class renders unstyled, a second
 * opener or one that is not first does not bleed to the page edge, a remote
 * image becomes a placeholder, a script never runs, a stylesheet, font, CSS
 * image or embed elsewhere never loads, and a skeleton's placeholders survive
 * into the output. Comments and the content of raw-text and inert elements
 * (`<style>`, `<textarea>`, `<template>`…) are not markup to it. Linear in the
 * size of the document, so the CLI runs it on every render.
 */
export function lintDocument(html: string): DocumentWarning[] {
  const warnings: DocumentWarning[] = [];
  const doc = parseDocument(html);
  const { body } = documentParts(doc);

  const accent = body ? attribute(body, "data-accent") : undefined;
  if (accent !== undefined && !(ACCENTS as readonly string[]).includes(accent)) {
    warnings.push({
      code: "unknown-accent",
      message: `data-accent="${accent}" is not an accent, so the document falls back to amber. Use one of: ${ACCENTS.join(", ")}.`,
    });
  }
  // The opener's CSS is body > .doc-hero:first-child, so what counts is the
  // body's first element child, a <style> included.
  const first = body?.childNodes.find(isElement);

  const unknown = new Set<string>();
  const openers: unknown[] = [];
  const remote: string[] = [];
  let placeholders = 0;
  let emptyLinks = 0;
  let scripts = 0;
  let network = 0;
  for (const el of elements(doc)) {
    const name = el.tagName;
    const classes = classList(el);
    for (const cls of classes) {
      if (cls.startsWith("doc-") && !KNOWN.has(cls)) unknown.add(cls);
    }
    if (classes.some((c) => (OPENER_CLASSES as readonly string[]).includes(c))) openers.push(el);
    if (name === "img" && attribute(el, "data-placeholder") !== undefined) placeholders++;
    if (name === "a" && /^#?$/.test((attribute(el, "href") ?? "").trim())) emptyLinks++;
    if (name === "span" && classes.includes("remote-image")) remote.push(textOf(el).replace(/^\[|\s*— not embedded\]$/g, ""));
    if (name === "script") scripts++;
    if (name === "iframe" || name === "object" || name === "embed" || name === "frame") network++;
    if (name === "link" && /\b(?:stylesheet|preload|modulepreload|prefetch|icon)\b/i.test(attribute(el, "rel") ?? "") && fetchesRemote(attribute(el, "href"))) network++;
    if (FETCHING.has(name) && (fetchesRemote(attribute(el, "src")) || fetchesRemote(attribute(el, "href")) || fetchesRemote(attribute(el, "xlink:href")))) network++;
    const style = attribute(el, "style");
    if (style !== undefined) network += cssFetches(style);
    if (name === "style") network += cssFetches(textOf(el));
  }

  for (const cls of unknown) {
    const near = suggestions(cls);
    warnings.push({
      code: "unknown-class",
      message: `class "${cls}" is not a document component, so it renders unstyled.${near.length ? ` Did you mean ${near.map((n) => `"${n}"`).join(", ")}?` : ""} \`brain render --blocks\` lists them all.`,
    });
  }
  if (openers.length > 1) {
    warnings.push({
      code: "several-openers",
      message: `The document has ${openers.length} openers (doc-hero, doc-letterhead). Keep one, as the first element in <body>.`,
    });
  } else if (openers.length === 1 && openers[0] !== first) {
    warnings.push({
      code: "opener-not-first",
      message: "The opener (doc-hero or doc-letterhead) is not the first element in <body>, so it does not reach the page edge. Move it to the top.",
    });
  }
  if (placeholders > 0) {
    warnings.push({
      code: "placeholder-image",
      message: `${plural(placeholders, "skeleton placeholder image")} left in (img[data-placeholder]). Replace each src with a data: URI or an allowed https URL and drop the attribute, or delete the image.`,
    });
  }
  if (remote.length > 0) {
    warnings.push({
      code: "remote-image",
      message: `${plural(remote.length, "remote image")} not embedded (${remote.join("; ")}). Pass --allow-host <host> for each image host, or inline them as data: URIs.`,
    });
  }
  if (emptyLinks > 0) {
    warnings.push({
      code: "empty-link",
      message: `${plural(emptyLinks, "link")} with an empty or "#" href. Point each at its real URL, or make it plain text.`,
    });
  }
  if (scripts > 0) {
    warnings.push({
      code: "script",
      message: "The page runs no JavaScript, so anything a <script> would draw is missing. Inline its output as HTML or SVG.",
    });
  }
  if (network > 0) {
    warnings.push({
      code: "network-resource",
      message: `${plural(network, "stylesheet, font, CSS image, embed or media reference", "stylesheets, fonts, CSS images, embeds or media references")} would load from elsewhere, and the page loads nothing: it renders without them. Inline the CSS and images as data: URIs, use system fonts, and link to embeds instead.`,
    });
  }
  return warnings;
}
