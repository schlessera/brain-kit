import type { ContentRenderer, ContentRendererPack, ContentRendererProps } from "../client/content-renderers.js";

/** @experimental One source/path exercised by the pack's renderer index. */
export interface ContentRendererFixture { renderer: number; source: string; path?: string }
/** @experimental Browser test harness; mount the real component and return its content root, not a wrapper. */
export interface ContentRendererFixtures {
  cases: readonly ContentRendererFixture[];
  mount(renderer: ContentRenderer, props: ContentRendererProps): Promise<{ element: Element; dispose(): void }>;
}

function requireConformance(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Content renderer conformance: ${message}`);
}

/** CSSOM parses declarations; inspect colour tokens at every nesting depth, not whole values. */
function hasColourLiteral(value: string): boolean {
  // Quoted strings and local resource identifiers are not colours. A valid token
  // reference is opaque; fallbacks remain visible and must obey the same rule.
  const remainder = value
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")
    .replace(/url\([^)]*\)/gi, "")
    .replace(/var\(--bk-[\w-]+\)/g, "");
  if (/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(remainder)) return true;
  return (remainder.match(/[-a-z_][-\w]*/gi) ?? []).some((token) =>
    CSS.supports("color", token) && !/^(currentcolor|inherit|initial|unset|revert|revert-layer|none)$/i.test(token));
}
function declarations(style: CSSStyleDeclaration, tokenBlock: boolean): void {
  for (const property of style) {
    const value = style.getPropertyValue(property).trim();
    requireConformance(!hasColourLiteral(value) || (tokenBlock && property.startsWith("--bk-")), `colour literal outside token block: ${property}: ${value}`);
    for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      requireConformance(match[1]!.trim().startsWith("#"), "external URL in static/style output");
    }
    requireConformance(!/\\/.test(value), "escaped or imported CSS resource");
  }
}

// A finite CSS/SVG paint inventory. Images' pixels and arbitrary SVG filter
// geometry remain pack-specific proof; CSS colours inside gradients/shadows do not.
const PAINT_ATTRIBUTES = ["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color"] as const;
const PRINT_PAINTS = [
  ...PAINT_ATTRIBUTES,
  "-webkit-text-fill-color", "-webkit-text-stroke-color", "scrollbar-color",
  "background-color", "background-image", "border-image-source",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "outline-color", "column-rule-color", "text-decoration-color", "text-emphasis-color",
  "caret-color", "accent-color", "box-shadow", "text-shadow", "filter",
] as const;
const PRINT_OPACITIES = ["opacity", "fill-opacity", "stroke-opacity", "stop-opacity", "flood-opacity"] as const;
function opacity(value: string): number { return Number.parseFloat(value) / (value.trim().endsWith("%") ? 100 : 1); }
function requireOpaquePaint(value: string, property: string): void {
  // Computed colours may be rgb()/rgba(), wide-gamut color(), Lab, etc., nested
  // inside a gradient or shadow. Inspect every colour function's explicit alpha.
  for (const match of value.matchAll(/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(([^()]*)\)/gi)) {
    const args = match[2]!;
    const alpha = args.includes("/") ? args.split("/").at(-1) : /^(rgba|hsla)$/i.test(match[1]!) ? args.split(",")[3] : undefined;
    requireConformance(alpha === undefined || opacity(alpha) === 1, `alpha fill in print: ${property}: ${value}`);
  }
  for (const match of value.matchAll(/\bopacity\(\s*([\d.]+%?)\s*\)/gi)) {
    requireConformance(opacity(match[1]!) === 1, `alpha fill in print: ${property}: ${value}`);
  }
}
function rules(list: CSSRuleList, tokenBlock: boolean): void {
  for (const rule of list) {
    requireConformance(rule.type !== CSSRule.IMPORT_RULE, "external stylesheet");
    if ("style" in rule) declarations((rule as CSSStyleRule).style, tokenBlock);
    if ("cssRules" in rule) rules((rule as CSSGroupingRule).cssRules, tokenBlock);
  }
}
function inspect(element: Element, print: boolean): void {
  requireConformance(element.isConnected, "fixture root must be mounted");
  const elements = [element, ...element.querySelectorAll("*")];
  requireConformance(elements.some((node) => !["STYLE", "DEFS", "TITLE", "DESC"].includes(node.tagName.toUpperCase())), "empty rendering");
  for (const node of elements) {
    if (node.localName === "style") {
      const sheet = (node as HTMLStyleElement).sheet;
      requireConformance(sheet !== null, "unreadable token/style sheet");
      rules(sheet!.cssRules, node.hasAttribute("data-content-renderer-tokens"));
    }
    if ("style" in node) declarations((node as HTMLElement).style, false);
    for (const attribute of PAINT_ATTRIBUTES) {
      const value = node.getAttribute(attribute);
      if (value !== null) requireConformance(/^(?:var\(--bk-[\w-]+\)|none|currentColor|url\(#[^)]+\))$/i.test(value), `colour literal outside token block: ${attribute}`);
    }
    if (print && node.localName !== "style") {
      const computed = getComputedStyle(node);
      for (const property of PRINT_PAINTS) {
        const value = computed.getPropertyValue(property);
        // Unpainted HTML backgrounds are transparent by default. The content
        // root still has the independent opaque-white ground assertion below.
        if (property === "background-color" && value === "rgba(0, 0, 0, 0)") continue;
        requireOpaquePaint(value, property);
      }
      for (const property of PRINT_OPACITIES) {
        const value = computed.getPropertyValue(property);
        requireConformance(value === "" || opacity(value) === 1, `alpha fill in print: ${property}: ${value}`);
      }
    }
  }
  if (print) requireConformance(getComputedStyle(element).backgroundColor === "rgb(255, 255, 255)", "print ground must equal document paper #ffffff");
}
function staticDocument(html: string): Element {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  requireConformance(!parsed.querySelector("script,iframe,object,embed,link,base,foreignObject"), "script or active element in static output");
  for (const node of parsed.querySelectorAll("*")) for (const attribute of node.attributes) {
    requireConformance(!/^on/i.test(attribute.name), "on* attribute in static output");
    for (const match of attribute.value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      requireConformance(match[1]!.trim().startsWith("#"), "external URL in static output");
    }
    if (/^(?:href|xlink:href|src|srcset|action|formaction|poster)$/i.test(attribute.name)) {
      requireConformance(attribute.value.startsWith("#"), "external URL in static output");
    }
  }
  // Validate resources before connecting anything to the live document.
  for (const style of parsed.querySelectorAll("style")) {
    requireConformance(!/@import|\\/i.test(style.textContent ?? ""), "imported or escaped CSS resource");
    const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent ?? "");
    rules(sheet.cssRules, style.hasAttribute("data-content-renderer-tokens"));
  }
  for (const node of parsed.querySelectorAll("[style]")) declarations((node as HTMLElement).style, false);
  const roots = [...parsed.body.children];
  // A preceding style lives in parsed.head; keep it inside the returned content root.
  requireConformance(roots.length === 1, "static output must have one content root");
  const root = document.importNode(roots[0]!, true);
  for (const style of parsed.head.querySelectorAll("style")) root.prepend(document.importNode(style, true));
  return root;
}

/**
 * Run in a real browser. Drives both real client components and static entries
 * through every theme. Throws on a violation; use the test runner's async assertion.
 * This tests trusted pack output, and is not a sanitizer for untrusted markup.
 * @experimental Part of the content-renderer seam.
 */
export async function contentRendererConformance(pack: ContentRendererPack, fixtures: ContentRendererFixtures): Promise<void> {
  requireConformance(pack.renderers.length > 0 && fixtures.cases.length > 0, "nonempty pack and fixtures required");
  for (let index = 0; index < pack.renderers.length; index++) requireConformance(fixtures.cases.some((fixture) => fixture.renderer === index), `missing fixture for renderer ${index}`);
  for (const fixture of fixtures.cases) {
    const renderer = pack.renderers[fixture.renderer];
    requireConformance(renderer !== undefined, "unknown fixture renderer");
    for (const theme of ["light", "dark", "print"] as const) {
      for (const mode of ["chat", "file", "share"] as const) {
        const props: ContentRendererProps = { source: fixture.source, path: fixture.path, mode, theme };
        const client = await fixtures.mount(renderer, props);
        try { inspect(client.element, theme === "print"); } finally { client.dispose(); }
      }
      const html = await renderer.toStatic(fixture.source, { theme, path: fixture.path });
      requireConformance(typeof html === "string" && html.trim().length > 0, "empty static rendering");
      const root = staticDocument(html);
      document.body.append(root);
      try { inspect(root, theme === "print"); } finally { root.remove(); }
    }
  }
}
