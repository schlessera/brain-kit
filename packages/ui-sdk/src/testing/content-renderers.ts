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

function declarations(style: CSSStyleDeclaration, tokenBlock: boolean): void {
  for (const property of style) {
    const value = style.getPropertyValue(property).trim();
    // Literal palette values belong exclusively to custom properties in the token block.
    const withoutReferences = value.replace(/var\(--bk-[\w-]+\)/g, "").trim();
    const literal = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(withoutReferences)
      || (CSS.supports("color", withoutReferences) && !/^(currentcolor|inherit|initial|unset|none)$/i.test(withoutReferences));
    requireConformance(!literal || (tokenBlock && property.startsWith("--bk-")), `colour literal outside token block: ${property}: ${value}`);
    // Resource references must stay within this artifact; escaped syntax is refused below.
    for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      requireConformance(match[1]!.trim().startsWith("#"), "external URL in static/style output");
    }
    requireConformance(!/\\/.test(value), "escaped or imported CSS resource");
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
    for (const attribute of ["fill", "stroke", "color", "stop-color", "flood-color"]) {
      const value = node.getAttribute(attribute);
      if (value !== null) requireConformance(/^(?:var\(--bk-[\w-]+\)|none|currentColor|url\(#[^)]+\))$/i.test(value), `colour literal outside token block: ${attribute}`);
    }
    if (print && node.localName !== "style") {
      const computed = getComputedStyle(node);
      for (const property of ["fill", "background-color", "stop-color", "flood-color"]) {
        const value = computed.getPropertyValue(property);
        // Transparent HTML backgrounds carry no paint; SVG fills and painted backgrounds must be opaque.
        if (!value || value === "none" || (property === "background-color" && value === "rgba(0, 0, 0, 0)")) continue;
        const alpha = /rgba?\([^)]*[,/]\s*([\d.]+)\s*\)$/.exec(value);
        requireConformance((!value.startsWith("rgba(") || alpha?.[1] === "1") && (!value.includes("/") || Number(/\/\s*([\d.]+)/.exec(value)?.[1] ?? 1) === 1), `alpha fill in print: ${property}: ${value}`);
      }
      requireConformance(Number(computed.opacity) === 1 && Number(computed.fillOpacity) === 1 && Number(computed.strokeOpacity) === 1, "alpha fill in print: opacity");
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
