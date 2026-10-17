/// <reference types="vite/client" />
import { afterEach, expect, test } from "vitest";
import source from "../../../module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml?raw";
import { buildDiagramLayout } from "../../../module-diagrams/src/layout.js";
import { DIAGRAM_TYPE } from "../../../module-diagrams/src/skin.js";
import type { DiagramSpec } from "../../../module-diagrams/src/spec.js";
let host: HTMLDivElement | undefined;
afterEach(() => host?.remove());
for (const layout of ["default", "narrow"] as const) test(`${layout}: exact adopted DELIVER label fits its computed mask in the pinned font`, async () => {
 const spec: DiagramSpec = JSON.parse(source), tree = buildDiagramLayout(spec, layout);
 host = document.createElement("div"); document.body.append(host);
 const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
 svg.setAttribute("width", String(tree.viewBox.width)); svg.setAttribute("height", String(tree.viewBox.height));
 svg.setAttribute("viewBox", `0 0 ${tree.viewBox.width} ${tree.viewBox.height}`); host.append(svg);
 expect((await document.fonts.load('600 9.5px "JetBrains Mono"')).length, "ACTUAL_PINNED_FONT_LOADED").toBeGreaterThan(0);
 const labels = tree.elements.filter(e => e.kind === "edge-label");
 expect(labels.map(e => e.text), "DELIVER_LABEL_RETAINED").toContain("DELIVER");
 for (const label of labels) {
  const text = document.createElementNS(svg.namespaceURI, "text") as SVGTextElement;
  text.textContent = label.text.toUpperCase(); text.setAttribute("x", String(label.x + 4)); text.setAttribute("y", String(label.y + 12));
  Object.assign(text.style, { fontFamily: DIAGRAM_TYPE.label.family, fontSize: `${label.fontSize}px`, fontWeight: String(DIAGRAM_TYPE.label.weight), letterSpacing: `${DIAGRAM_TYPE.label.tracking * label.fontSize}px` }); svg.append(text);
  await document.fonts.ready;
  const bounds = text.getBBox(), scale = text.getScreenCTM()!;
  expect(bounds.x, `${label.text}: MASK_LEFT`).toBeGreaterThanOrEqual(label.x);
  expect(bounds.x + bounds.width, `${label.text}: MASK_RIGHT`).toBeLessThanOrEqual(label.x + label.width);
  expect(bounds.y, `${label.text}: MASK_TOP`).toBeGreaterThanOrEqual(label.y);
  expect(bounds.y + bounds.height, `${label.text}: MASK_BOTTOM`).toBeLessThanOrEqual(label.y + label.height);
  expect(label.fontSize * Math.hypot(scale.a, scale.b), `${label.text}: DISPLAYED_TYPE_FLOOR`).toBeGreaterThanOrEqual(9);
 }
});
