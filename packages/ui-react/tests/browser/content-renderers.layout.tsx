import { expect, test } from "vitest";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ContentRenderer, ContentRendererProps } from "@schlessera/brain-ui-sdk/client";
import { contentRendererConformance } from "@schlessera/brain-ui-sdk/testing";

const tokens = ".odyssey-figure { --bk-ground: #ffffff; --bk-ink: #222222; --bk-wash: rgba(0,0,0,0.3); background: var(--bk-ground); color: var(--bk-ink); }";
function Figure({ source }: ContentRendererProps) {
  return <div className="odyssey-figure"><style data-content-renderer-tokens="">{tokens}</style><svg><rect width="20" height="20" fill="var(--bk-ink)"/><text>{source}</text></svg></div>;
}
const compliant: ContentRenderer = {
  languages: ["odyssey"], extensions: [".odyssey"], needsBrowser: false, Component: Figure,
  async toStatic(source) { return `<div class="odyssey-figure"><style data-content-renderer-tokens>${tokens}</style><svg><rect width="20" height="20" fill="var(--bk-ink)"/><text>${source}</text></svg></div>`; },
};
const fixtures = {
  cases: [{ renderer: 0, source: "The homecoming relay" }],
  async mount(renderer: ContentRenderer, props: ContentRendererProps) {
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    flushSync(() => root.render(createElement(renderer.Component, props)));
    return { element: host.firstElementChild!, dispose() { flushSync(() => root.unmount()); host.remove(); } };
  },
};
test("real client and static fixtures pass all three themes", async () => {
  const themes: string[] = [];
  const renderer = { ...compliant, async toStatic(source: string, options: { theme: "light" | "dark" | "print" }) { themes.push(options.theme); return compliant.toStatic(source, options); } };
  const modes: string[] = [];
  await contentRendererConformance({ renderers: [renderer] }, { ...fixtures, async mount(entry, props) { modes.push(`${props.theme}:${props.mode}`); return fixtures.mount(entry, props); } });
  expect(modes).toEqual(["light:chat", "light:file", "light:share", "dark:chat", "dark:file", "dark:share", "print:chat", "print:file", "print:share"]);
  expect(themes).toEqual(["light", "dark", "print"]);
});
test("conformance rejects translucent print fill in a real mounted component", async () => {
  const renderer = { ...compliant, Component(props: ContentRendererProps) { return <div className="odyssey-figure"><style data-content-renderer-tokens="">{tokens}</style><svg><rect fill={props.theme === "print" ? "var(--bk-wash)" : "var(--bk-ink)"}/></svg></div>; } };
  await expect(contentRendererConformance({ renderers: [renderer] }, fixtures)).rejects.toThrow("alpha fill in print");
});
for (const [name, markup, reason] of [
  ["script", "<script>throw Error('unsafe')</script>", "script or active element"],
  ["event handler", '<svg onload="void 0"></svg>', "on* attribute"],
  ["external URL", '<img src="https://example.invalid/raft.svg">', "external URL"],
  ["CSS resource", '<style>.odyssey-figure {background-image:url(https://example.invalid/raft.svg)}</style>', "external URL"],
  ["named shorthand colour", '<style>.odyssey-figure {border:1px solid red}</style>', "colour literal outside token block"],
  ["literal fallback colour", '<svg><rect fill="var(--bk-ink,red)"/></svg>', "colour literal outside token block"],
  ["literal colour", '<svg><rect fill="red"/></svg>', "colour literal outside token block"],
] as const) test(`conformance rejects static ${name}`, async () => {
  const renderer = { ...compliant, async toStatic() { return `<div class="odyssey-figure"><style data-content-renderer-tokens>${tokens}</style>${markup}</div>`; } };
  await expect(contentRendererConformance({ renderers: [renderer] }, fixtures)).rejects.toThrow(reason);
});
test("conformance rejects an opaque off-white print ground", async () => {
  const renderer = { ...compliant, async toStatic(source: string, options: { theme: "light" | "dark" | "print" }) { return (await compliant.toStatic(source, options)).replace("#ffffff", "#f8f5ef"); } };
  await expect(contentRendererConformance({ renderers: [renderer] }, fixtures)).rejects.toThrow("print ground");
});
test("conformance requires every renderer to have a fixture", async () => {
  await expect(contentRendererConformance({ renderers: [compliant, compliant] }, fixtures)).rejects.toThrow("missing fixture for renderer 1");
});

test("conformance rejects translucent static print fill", async () => {
  const renderer = { ...compliant, async toStatic(source: string, options: { theme: "light" | "dark" | "print" }) { return (await compliant.toStatic(source, options)).replace('fill="var(--bk-ink)"', 'fill="var(--bk-wash)"'); } };
  await expect(contentRendererConformance({ renderers: [renderer] }, fixtures)).rejects.toThrow("alpha fill in print");
});
test("conformance checks client SVG token styles and named literals", async () => {
  const renderer = { ...compliant, Component() { return <svg><style>{'.ship {fill:red}'}</style><rect className="ship"/></svg>; } };
  await expect(contentRendererConformance({ renderers: [renderer] }, fixtures)).rejects.toThrow("colour literal outside token block");
});
test("a renderer that cannot produce a theme fails conformance", async () => {
  const renderer = { ...compliant, async toStatic(source: string, options: { theme: "light" | "dark" | "print" }) { if(options.theme === "dark") throw Error("dark fixture failure"); return compliant.toStatic(source, options); } };
  await expect(contentRendererConformance({ renderers: [renderer] }, fixtures)).rejects.toThrow("dark fixture failure");
});
