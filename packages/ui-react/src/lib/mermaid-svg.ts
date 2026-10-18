import type { MermaidTheme } from "./mermaid-theme.js";
import { mermaidThemeVariables } from "./mermaid-theme.js";

const SVG = "http://www.w3.org/2000/svg";
const paintAttributes = ["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color"];
const opacityProperties = new Set(["opacity", "fill-opacity", "stroke-opacity", "stop-opacity", "flood-opacity"]);

function parsedSvg(markup: string): SVGSVGElement {
  // Mermaid emits HTML void tags in foreignObject labels (for example <br>).
  // Parse with the browser's SVG/HTML integration rules, then serialize as XML.
  const document = new DOMParser().parseFromString(markup, "text/html");
  const svg = document.body.firstElementChild;
  if (svg?.namespaceURI !== SVG || svg.localName !== "svg" || svg.nextElementSibling) throw Error("Invalid Mermaid SVG.");
  return svg as unknown as SVGSVGElement;
}

function localResources(svg: SVGSVGElement): void {
  if (svg.querySelector("script,iframe,object,embed,link,base")) throw Error("Active Mermaid static content.");
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) throw Error("Active Mermaid static attribute.");
      if (/^(?:href|xlink:href|src|srcset|action|formaction|poster)$/i.test(attribute.name) && !attribute.value.startsWith("#")) {
        throw Error("External Mermaid static resource.");
      }
    }
  }
  for (const style of svg.querySelectorAll("style")) {
    if (/@import|\\/.test(style.textContent ?? "")) throw Error("Imported or escaped Mermaid stylesheet.");
  }
}

/** Bridge Mermaid's generated literal paints into a scoped, explicit token block. */
export function tokenizedMermaidSvg(markup: string, theme: MermaidTheme): string {
  const svg = parsedSvg(markup);
  const id = svg.id;
  if (!/^brain-mermaid-\d+$/.test(id)) throw Error("Unexpected Mermaid SVG identity.");
  const tokens = new Map<string, string>();
  const pass = svg.querySelectorAll("style[data-content-renderer-tokens]").length;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  function token(value: string, property: string): string {
    if (theme === "print") {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      if (alpha === 0 && ["fill", "stroke", "stop-color", "flood-color"].includes(property)) return "none";
      if (alpha < 255) {
        // Printed paper is opaque white: retain the appearance without alpha ink.
        const mix = (channel: number) => Math.round(channel * alpha / 255 + 255 - alpha);
        value = `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
      }
    }
    let name = tokens.get(value);
    if (!name) { name = `--bk-mermaid-${id.slice("brain-mermaid-".length)}-${pass}-${tokens.size}`; tokens.set(value, name); }
    return `var(${name})`;
  }
  function colourValue(value: string, property: string): string {
    // Walk CSS tokens rather than replacing substrings inside names, quoted
    // font stacks, local marker URLs, or an existing custom-property reference.
    return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#[\da-f]{3,8}\b|[-a-z_][\w-]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?/gi, part => {
      if (/^["']/.test(part) || /^var\(/i.test(part)) return part;
      if (/^url\(/i.test(part)) {
        if (!/^url\(\s*["']?#/i.test(part)) throw Error("External Mermaid paint resource.");
        return part;
      }
      if (/^(?:none|currentcolor|inherit|initial|unset|revert|revert-layer)$/i.test(part)) return part;
      if (CSS.supports("color", part)) return token(part, property);
      const opening = part.indexOf("(");
      return opening < 0 ? part : part.slice(0, opening + 1) + colourValue(part.slice(opening + 1, -1), property) + ")";
    });
  }
  function declarations(style: CSSStyleDeclaration): void {
    for (const property of [...style]) {
      const value = style.getPropertyValue(property), priority = style.getPropertyPriority(property);
      style.setProperty(property, theme === "print" && opacityProperties.has(property) ? "1" : colourValue(value, property), priority);
    }
  }
  function rules(list: CSSRuleList): void {
    for (const rule of list) {
      if (rule.type === CSSRule.IMPORT_RULE) throw Error("Imported Mermaid stylesheet.");
      if ("style" in rule) declarations((rule as CSSStyleRule).style);
      if ("cssRules" in rule) rules((rule as CSSGroupingRule).cssRules);
    }
  }
  for (const style of svg.querySelectorAll("style")) {
    if (style.hasAttribute("data-content-renderer-tokens")) continue;
    const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent ?? ""); rules(sheet.cssRules);
    style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join("\n");
  }
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    if ("style" in element) declarations((element as SVGElement).style);
    for (const property of paintAttributes) {
      const value = element.getAttribute(property);
      if (value !== null) element.setAttribute(property, colourValue(value, property));
    }
    if (theme === "print") for (const property of opacityProperties) if (element.hasAttribute(property)) element.setAttribute(property, "1");
  }
  if (theme === "print") svg.style.backgroundColor = token(String(mermaidThemeVariables("print").background), "background-color");
  if (tokens.size) {
    const style = svg.ownerDocument.createElementNS(SVG, "style");
    style.setAttribute("data-content-renderer-tokens", "");
    style.textContent = `#${id}{${[...tokens].map(([value, name]) => `${name}:${value};`).join("")}}`;
    svg.prepend(style);
  }
  return new XMLSerializer().serializeToString(svg);
}

/**
 * Preserve browser-measured label positions as vector text. Static output
 * cannot retain HTML foreignObject labels, even though Mermaid sanitized them.
 */
export function staticMermaidSvg(markup: string, theme: MermaidTheme): string {
  const parsed = parsedSvg(markup);
  localResources(parsed);
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-100000px;top:0;width:${parsed.viewBox.baseVal.width || 1200}px;visibility:hidden;pointer-events:none`;
  const svg = document.importNode(parsed, true);
  container.append(svg); document.body.append(container);
  try {
    for (const foreign of svg.querySelectorAll("foreignObject")) {
      if (foreign.querySelector("img,svg,math,canvas,video,audio")) throw Error("Mermaid label requires unsupported static content.");
      const parent = foreign.parentElement as unknown as SVGGraphicsElement;
      const inverse = parent.getScreenCTM()?.inverse();
      if (!inverse) throw Error("Mermaid label has no measured geometry.");
      const output = document.createElementNS(SVG, "g");
      const walker = document.createTreeWalker(foreign, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      while (walker.nextNode()) texts.push(walker.currentNode as Text);
      for (const text of texts) {
        if (!text.textContent?.trim() || !text.parentElement) continue;
        const computed = getComputedStyle(text.parentElement);
        const baseline = document.createElement("span");
        baseline.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
        text.after(baseline);
        const characters: { value: string; box: DOMRect }[] = [];
        let offset = 0;
        for (const character of text.textContent) {
          const range = document.createRange(); range.setStart(text, offset); offset += character.length; range.setEnd(text, offset);
          const box = range.getBoundingClientRect();
          if (box.width || !/\s/.test(character)) characters.push({ value: character, box });
        }
        const last = characters.at(-1);
        if (!last) { baseline.remove(); continue; }
        const baselineOffset = baseline.getBoundingClientRect().top - last.box.top;
        const lines: { value: string; box: DOMRect }[] = [];
        for (const character of characters) {
          const line = lines.at(-1);
          if (line && Math.abs(line.box.top - character.box.top) < 0.5) line.value += character.value;
          else lines.push({ ...character });
        }
        baseline.remove();
        for (const line of lines) {
          const point = new DOMPoint(line.box.left, line.box.top + baselineOffset).matrixTransform(inverse);
          const label = document.createElementNS(SVG, "text");
          label.setAttribute("x", String(point.x)); label.setAttribute("y", String(point.y));
          label.setAttribute("xml:space", "preserve"); label.textContent = line.value;
          for (const property of ["font-family", "font-size", "font-weight", "font-style", "font-variant", "letter-spacing", "word-spacing", "text-decoration", "direction"]) {
            label.style.setProperty(property, computed.getPropertyValue(property));
          }
          label.style.fill = computed.color;
          output.append(label);
        }
      }
      foreign.replaceWith(output);
    }
    return tokenizedMermaidSvg(new XMLSerializer().serializeToString(svg), theme);
  } finally { container.remove(); }
}
