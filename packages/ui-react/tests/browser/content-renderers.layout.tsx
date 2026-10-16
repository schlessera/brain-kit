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

// Independent-review regressions exercise the public compiled entry on both paths.
const reviewPaints = ["stroke", "stop-opacity", "stop-colour", "flood-opacity", "flood-colour", "background-alpha", "shadow-alpha", "filter-alpha", "filter-opacity", "text-fill-alpha", "text-stroke-alpha", "gradient-literal", "shadow-literal", "filter-literal", "text-shadow-literal"] as const;
type ReviewPaint = typeof reviewPaints[number];
function reviewMarkup(paint: ReviewPaint): string {
  switch (paint) {
    case "stroke": return '<svg><rect fill="none" stroke="var(--bk-wash)"/></svg>';
    case "stop-opacity": return '<svg><defs><linearGradient id="relay"><stop stop-color="var(--bk-ink)" stop-opacity="0.3"/></linearGradient></defs><rect fill="url(#relay)"/></svg>';
    case "stop-colour": return '<svg><defs><linearGradient id="relay"><stop stop-color="var(--bk-wash)"/></linearGradient></defs><rect fill="url(#relay)"/></svg>';
    case "flood-opacity": return '<svg><filter id="mist"><feFlood flood-color="var(--bk-ink)" flood-opacity="0.3"/></filter><rect style="filter:url(#mist)"/></svg>';
    case "flood-colour": return '<svg><filter id="mist"><feFlood flood-color="var(--bk-wash)"/></filter><rect style="filter:url(#mist)"/></svg>';
    case "background-alpha": return '<div style="background-image:linear-gradient(var(--bk-wash),var(--bk-ink))">Raft</div>';
    case "shadow-alpha": return '<div style="box-shadow:0 0 1px var(--bk-wash)">Raft</div>';
    case "filter-alpha": return '<div style="filter:drop-shadow(0 0 1px var(--bk-wash))">Raft</div>';
    case "filter-opacity": return '<div style="filter:opacity(0.3)">Raft</div>';
    case "text-fill-alpha": return '<div style="-webkit-text-fill-color:var(--bk-wash)">Raft</div>';
    case "text-stroke-alpha": return '<div style="-webkit-text-stroke-color:var(--bk-wash);-webkit-text-stroke-width:1px">Raft</div>';
    case "gradient-literal": return '<div style="background-image:linear-gradient(red,blue)">Raft</div>';
    case "shadow-literal": return '<div style="box-shadow:0 0 1px red">Raft</div>';
    case "filter-literal": return '<div style="filter:drop-shadow(0 0 1px red)">Raft</div>';
    case "text-shadow-literal": return '<div style="text-shadow:0 0 1px red">Raft</div>';
  }
}
function ReviewPaintComponent({ paint }: { paint: ReviewPaint }) {
  switch (paint) {
    case "stroke": return <svg><rect fill="none" stroke="var(--bk-wash)"/></svg>;
    case "stop-opacity": return <svg><defs><linearGradient id="relay"><stop stopColor="var(--bk-ink)" stopOpacity={0.3}/></linearGradient></defs><rect fill="url(#relay)"/></svg>;
    case "stop-colour": return <svg><defs><linearGradient id="relay"><stop stopColor="var(--bk-wash)"/></linearGradient></defs><rect fill="url(#relay)"/></svg>;
    case "flood-opacity": return <svg><filter id="mist"><feFlood floodColor="var(--bk-ink)" floodOpacity={0.3}/></filter><rect style={{ filter: "url(#mist)" }}/></svg>;
    case "flood-colour": return <svg><filter id="mist"><feFlood floodColor="var(--bk-wash)"/></filter><rect style={{ filter: "url(#mist)" }}/></svg>;
    default: {
      const style = {
        "background-alpha": { backgroundImage: "linear-gradient(var(--bk-wash),var(--bk-ink))" },
        "shadow-alpha": { boxShadow: "0 0 1px var(--bk-wash)" },
        "filter-alpha": { filter: "drop-shadow(0 0 1px var(--bk-wash))" },
        "filter-opacity": { filter: "opacity(0.3)" },
        "text-fill-alpha": { WebkitTextFillColor: "var(--bk-wash)" },
        "text-stroke-alpha": { WebkitTextStrokeColor: "var(--bk-wash)", WebkitTextStrokeWidth: "1px" },
        "gradient-literal": { backgroundImage: "linear-gradient(red,blue)" },
        "shadow-literal": { boxShadow: "0 0 1px red" },
        "filter-literal": { filter: "drop-shadow(0 0 1px red)" },
        "text-shadow-literal": { textShadow: "0 0 1px red" },
      }[paint];
      return <div style={style}>Raft</div>;
    }
  }
}
for (const path of ["client", "static"] as const) for (const paint of reviewPaints) test(`review ${path} rejects ${paint}`, async () => {
  const renderer: ContentRenderer = {
    ...compliant,
    Component: path === "client" ? () => <div className="odyssey-figure"><style data-content-renderer-tokens="">{tokens}</style><ReviewPaintComponent paint={paint}/></div> : Figure,
    toStatic: path === "static" ? async () => `<div class="odyssey-figure"><style data-content-renderer-tokens>${tokens}</style>${reviewMarkup(paint)}</div>` : compliant.toStatic,
  };
  await expect(contentRendererConformance({ renderers: [renderer] }, fixtures), `REVIEW_${path}_${paint}`).rejects.toThrow(paint.endsWith("literal") ? "colour literal outside token block" : "alpha fill in print");
});
test("review opaque gradients, named token colours and compound shadows remain valid", async () => {
  const opaqueTokens = tokens.replace("--bk-ink: #222222", "--bk-ink: midnightblue; --bk-other: darkred");
  function Opaque() { return <div className="odyssey-figure"><style data-content-renderer-tokens="">{opaqueTokens}</style><svg><defs><linearGradient id="opaque-relay"><stop stopColor="var(--bk-ink)"/><stop offset="1" stopColor="var(--bk-other)"/></linearGradient></defs><rect fill="url(#opaque-relay)" stroke="var(--bk-other)"/></svg><div style={{ backgroundImage: "linear-gradient(color-mix(in srgb,var(--bk-ink),var(--bk-other)),var(--bk-other))", boxShadow: "0 0 1px var(--bk-ink)", textShadow: "0 0 1px var(--bk-other)", filter: "drop-shadow(0 0 1px var(--bk-ink)) opacity(1)" }}>Raft</div></div>; }
  const renderer = { ...compliant, Component: Opaque, async toStatic() { return `<div class="odyssey-figure"><style data-content-renderer-tokens>${opaqueTokens}</style><svg><defs><linearGradient id="opaque-relay"><stop stop-color="var(--bk-ink)"/><stop offset="1" stop-color="var(--bk-other)"/></linearGradient></defs><rect fill="url(#opaque-relay)" stroke="var(--bk-other)"/></svg><div style="background-image:linear-gradient(color-mix(in srgb,var(--bk-ink),var(--bk-other)),var(--bk-other));box-shadow:0 0 1px var(--bk-ink);text-shadow:0 0 1px var(--bk-other);filter:drop-shadow(0 0 1px var(--bk-ink)) opacity(1)">Raft</div></div>`; } };
  await contentRendererConformance({ renderers: [renderer] }, fixtures);
});
