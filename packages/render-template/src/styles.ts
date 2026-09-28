/**
 * The document stylesheet every render is wrapped in (#530).
 *
 * Everything, `@page` included, sits in `@layer brain-document`, so any
 * unlayered rule an author writes wins over it whatever its specificity. That
 * is what lets a full HTML document keep its own look, and its own page
 * margins, with this sheet injected under it. Colours are the kit's light/print tokens copied as literals, because the
 * render page loads nothing.
 *
 * The class names are the contract, not the declarations: `DOCUMENT_CLASSES`
 * (`components.ts`) lists every one, and a test holds the two to each other.
 *
 * Per-document switches, all optional, on `<body>`:
 *   data-accent="amber|teal|blue|purple|graphite"   default amber
 *   class="doc--editorial"   serif display type (letters, memos, essays)
 *   class="doc--compact"     tighter rhythm (invoices, dense references)
 *
 * `String.raw` keeps CSS escapes such as `"\2192"` intact; a plain template
 * literal would read them as octal escapes.
 */
export const STYLES = String.raw`
@layer brain-document {
  @page { size: A4; margin: 14mm 0 16mm; }
  @page :first { margin-top: 0; }
  @page doc-cover { margin: 0; }

  :root {
    color-scheme: light;
    --doc-paper: #ffffff;
    --doc-tint: #f7f4ee;
    --doc-line: #e8e2d7;
    --doc-edge: #cbc3b2;
    --doc-ink: #1f1b16;
    --doc-ink-dim: #554f45;
    --doc-ink-mute: #5f584c;
    --doc-on-fill: #1f1b16;
    --doc-ok: #15594c;
    --doc-warn: #6f540c;
    --doc-bad: #9c2a24;
    --doc-ok-ground: #e6f3ef;
    --doc-warn-ground: #fbf1dc;
    --doc-bad-ground: #fce8e6;

    --accent: #7f4c08;
    --accent-fill: #e09f3e;
    --accent-ground: color-mix(in srgb, var(--accent-fill) 16%, #fff);
    --accent-wash: color-mix(in srgb, var(--accent-fill) 8%, #fff);

    /* "Noto Sans Symbols2" is how Debian's fonts-noto-core names the family. */
    --doc-symbols: "Noto Sans Symbols 2", "Noto Sans Symbols2", "Noto Sans Symbols", "Segoe UI Symbol", "Apple Symbols",
      "DejaVu Sans", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji";
    --doc-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Liberation Sans", Arial,
      sans-serif, var(--doc-symbols);
    --doc-serif: "Iowan Old Style", "Palatino Linotype", Palatino, Charter, "Bitstream Charter",
      Georgia, "Noto Serif", "DejaVu Serif", serif, var(--doc-symbols);
    --doc-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace;
    --doc-display: var(--doc-sans);
    --doc-display-weight: 700;
    --doc-display-track: -0.022em;

    --page-x: 52px;
    --page-top: 48px;
    --page-bottom: 52px;
    --gutter: max(var(--page-x), calc((100vw - 720px) / 2));
    --flow: 1;
    --radius: 12px;
  }
  body[data-accent="teal"]     { --accent: #15594c; --accent-fill: #5bb5a2; }
  body[data-accent="blue"]     { --accent: #1a5c7f; --accent-fill: #67b8e3; }
  body[data-accent="purple"]   { --accent: #5d4489; --accent-fill: #b197d4; }
  body[data-accent="graphite"] { --accent: #3b3630; --accent-fill: #b9b0a0; }
  body.doc--editorial { --doc-display: var(--doc-serif); --doc-display-weight: 400; --doc-display-track: -0.005em; }
  body.doc--compact { --flow: 0.72; font-size: 14px; }

  @media (max-width: 560px) {
    :root { --page-x: 20px; --page-top: 24px; --page-bottom: 28px; }
  }
  @media print {
    :root { --page-x: 18mm; --page-top: 14mm; --page-bottom: 0px; --gutter: var(--page-x); }
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--doc-paper); }
  body {
    font-family: var(--doc-sans);
    font-size: 15px; line-height: 1.6; color: var(--doc-ink);
    padding: var(--page-top) var(--gutter) var(--page-bottom);
    overflow-wrap: break-word;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    orphans: 3; widows: 3;
    font-variant-numeric: tabular-nums;
  }

  /* Prose */
  /* break-inside too: h2 draws its accent bar as a block ::before, which a page
     break could otherwise leave at the foot of the previous page. */
  h1, h2, h3, h4, h5, h6 { color: var(--doc-ink); text-wrap: balance; break-after: avoid; break-inside: avoid; }
  h1 {
    font-family: var(--doc-display); font-weight: var(--doc-display-weight);
    letter-spacing: var(--doc-display-track);
    font-size: 36px; line-height: 1.1; margin: 0 0 0.45em;
  }
  h2 {
    font-family: var(--doc-display); font-weight: var(--doc-display-weight);
    letter-spacing: var(--doc-display-track);
    font-size: 22px; line-height: 1.25; margin: calc(2.1em * var(--flow)) 0 0.5em;
  }
  h2::before {
    content: ""; display: block; width: 28px; height: 3px; border-radius: 2px;
    background: var(--accent-fill); margin-bottom: 12px;
  }
  .doc-n { color: var(--accent); font-family: var(--doc-sans); font-weight: 600; font-size: 0.62em; letter-spacing: 0.04em; margin-right: 0.6em; vertical-align: 0.18em; }
  h3 { font-size: 16px; font-weight: 650; line-height: 1.35; margin: calc(1.6em * var(--flow)) 0 0.35em; }
  h4, h5, h6 {
    font-size: 11.5px; font-weight: 700; line-height: 1.4; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--doc-ink-mute); margin: calc(1.6em * var(--flow)) 0 0.5em;
  }
  h1 + h2, h2 + h3, h3 + h4 { margin-top: 0.6em; }

  p { margin: 0 0 calc(0.85em * var(--flow)); text-wrap: pretty; }
  strong, b { font-weight: 650; }
  small { font-size: 13px; color: var(--doc-ink-mute); }
  a {
    color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px;
    text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent); text-underline-offset: 2px;
  }
  ul, ol { margin: 0 0 calc(0.85em * var(--flow)); padding-left: 1.3em; }
  li { margin: 0.25em 0; padding-left: 0.2em; }
  li::marker { color: var(--accent); }
  li > ul, li > ol { margin: 0.25em 0 0; }
  blockquote { margin: 1.2em 0; padding: 0 0 0 1.1em; border-left: 2px solid var(--accent-fill); color: var(--doc-ink-dim); }
  blockquote > :last-child { margin-bottom: 0; }
  code, kbd, samp { font-family: var(--doc-mono); font-size: 0.86em; }
  :not(pre) > code { background: var(--doc-tint); padding: 0.12em 0.35em; border-radius: 4px; }
  pre { background: var(--doc-tint); border-radius: 8px; padding: 14px 16px; margin: 1.1em 0; font-size: 13.5px; line-height: 1.55; overflow-x: auto; white-space: pre-wrap; }
  pre code { font-size: inherit; }
  hr { border: 0; border-top: 1px solid var(--doc-line); margin: calc(2.2em * var(--flow)) 0; }

  table { width: 100%; border-collapse: collapse; margin: 1.1em 0 1.4em; font-size: 14px; line-height: 1.5; }
  th, td { text-align: left; vertical-align: top; padding: calc(9px * var(--flow)) 14px calc(9px * var(--flow)) 0; border-bottom: 1px solid var(--doc-line); }
  th:last-child, td:last-child { padding-right: 0; }
  thead th { font-size: 11.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--doc-ink-mute); border-bottom: 1.5px solid var(--doc-ink); padding-top: 0; }
  tbody tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; }
  tr { break-inside: avoid; }
  table.doc-zebra th, table.doc-zebra td { border-bottom: 0; padding-left: 12px; padding-right: 12px; }
  table.doc-zebra tbody tr:nth-child(odd) { background: var(--doc-tint); }

  img, svg, video { max-width: 100%; height: auto; }
  figure { margin: 1.4em 0; break-inside: avoid; }
  figure img { display: block; width: 100%; border-radius: var(--radius); }
  figcaption { margin-top: 0.55em; font-size: 13px; line-height: 1.45; color: var(--doc-ink-mute); }
  .mermaid-figure { margin: 1.4em 0; text-align: center; break-inside: avoid; }
  .mermaid-figure svg { max-width: 100%; height: auto; }
  .remote-image { display: inline-block; padding: 2px 8px; border: 1px dashed var(--doc-edge); border-radius: 4px; color: var(--doc-ink-mute); font-size: 0.9em; }

  /* Openers: one per document, always first */
  .doc-hero {
    margin: 0 calc(-1 * var(--gutter)) calc(2.4em * var(--flow));
    padding: 40px var(--gutter) 34px;
    background: var(--accent-wash);
    break-inside: avoid;
  }
  body > .doc-hero:first-child { margin-top: calc(-1 * var(--page-top)); padding-top: calc(var(--page-top) + 40px); }
  .doc-eyebrow { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); margin: 0 0 14px; }
  .doc-hero h1 { font-size: 46px; line-height: 1.04; margin: 0 0 0.3em; }
  .doc-hero > p, .doc-hero-text > p { font-size: 18px; line-height: 1.5; color: var(--doc-ink-dim); max-width: 32em; margin: 0; }
  .doc-hero .doc-kv--facts { margin-top: 28px; margin-bottom: 0; }
  .doc-hero-image {
    display: block; width: calc(100% + 2 * var(--gutter)); max-width: none;
    margin: 30px calc(-1 * var(--gutter)) -34px;
    aspect-ratio: 2.4 / 1; object-fit: cover; border-radius: 0;
  }
  /* Solid: the accent fill as the ground. Reports, announcements. */
  .doc-hero--solid { background: var(--accent-fill); }
  .doc-hero--solid .doc-eyebrow, .doc-hero--solid > p, .doc-hero--solid .doc-kv dt { color: var(--doc-on-fill); }
  .doc-hero--solid .doc-kv--facts > div { border-top-color: color-mix(in srgb, var(--doc-on-fill) 45%, transparent); }
  /* Split: text beside a full-height image that bleeds right. Recipes, places, profiles. */
  .doc-hero--split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 0 36px; padding-right: 0; padding-bottom: 0; align-items: stretch; }
  body > .doc-hero--split:first-child { padding-top: 0; }
  .doc-hero--split .doc-hero-text { padding: 40px 0 34px; align-self: end; }
  body > .doc-hero--split:first-child .doc-hero-text { padding-top: calc(var(--page-top) + 40px); }
  .doc-hero--split .doc-hero-image { width: 100%; height: auto; min-height: 340px; margin: 0; aspect-ratio: auto; align-self: stretch; }
  /* Cover: a whole first page. Invitations, programmes, proposals. */
  .doc-hero--cover {
    display: flex; flex-direction: column; justify-content: flex-end;
    min-height: calc(100vw * 1.4142); padding-bottom: 56px;
    background: var(--accent-fill); position: relative; overflow: hidden;
    break-after: page; margin-bottom: 48px;
  }
  .doc-hero--cover h1 { font-size: 64px; line-height: 1; }
  .doc-hero--cover .doc-eyebrow, .doc-hero--cover > p { color: var(--doc-on-fill); }
  .doc-hero--cover > .doc-hero-image { position: absolute; inset: 0 0 42% 0; width: 100%; height: 58%; margin: 0; aspect-ratio: auto; }
  /* In print the cover is its own named page with no margins, so it bleeds on
     all four sides. 296mm, not 297mm: a box exactly one page tall can round
     over and push an empty page after it. */
  @media print { .doc-hero--cover { page: doc-cover; min-height: 296mm; margin-bottom: 0; } }
  /* Letterhead: a compact top line for letters, memos, invoices. */
  .doc-letterhead {
    display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 12px 32px;
    margin: 0 0 calc(2.2em * var(--flow)); padding-bottom: 18px;
    border-bottom: 1.5px solid var(--doc-ink); break-inside: avoid;
  }
  body > .doc-letterhead:first-child { margin-top: calc(-1 * var(--page-top)); padding-top: calc(var(--page-top) + 28px); box-shadow: inset 0 6px 0 var(--accent-fill); margin-left: calc(-1 * var(--gutter)); margin-right: calc(-1 * var(--gutter)); padding-left: var(--gutter); padding-right: var(--gutter); border-bottom: 0; background: linear-gradient(var(--doc-ink), var(--doc-ink)) bottom / calc(100% - 2 * var(--gutter)) 1.5px no-repeat; }
  .doc-mark { font-family: var(--doc-display); font-weight: var(--doc-display-weight); letter-spacing: var(--doc-display-track); font-size: 20px; line-height: 1.2; }
  .doc-mark small { display: block; font-family: var(--doc-sans); font-size: 12.5px; letter-spacing: 0; font-weight: 400; margin-top: 2px; }
  .doc-letterhead address { font-style: normal; font-size: 12.5px; line-height: 1.5; color: var(--doc-ink-mute); text-align: right; }

  /* Blocks */
  .doc-kv { display: grid; grid-template-columns: minmax(7em, max-content) 1fr; gap: 6px 20px; margin: 1em 0 1.3em; break-inside: avoid; }
  .doc-kv > div { display: contents; }
  .doc-kv dt { color: var(--doc-ink-mute); font-size: 14px; }
  .doc-kv dd { margin: 0; }
  .doc-kv--stacked { grid-template-columns: minmax(0, 1fr); gap: 1px; }
  .doc-kv--stacked dd + dt { margin-top: 10px; }
  .doc-kv--row { display: flex; flex-wrap: wrap; gap: 10px 36px; }
  .doc-kv--row > div { display: block; }
  .doc-kv--row dt, .doc-kv--facts dt { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  .doc-kv--row dd { margin-top: 2px; }
  .doc-kv--facts { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 16px 24px; }
  .doc-kv--facts > div { display: block; border-top: 1.5px solid var(--doc-ink); padding-top: 9px; }
  .doc-kv--facts dd { font-size: 17px; font-weight: 650; line-height: 1.3; margin-top: 4px; }
  .doc-kv--facts dd small { display: block; font-weight: 400; margin-top: 2px; color: inherit; opacity: 0.8; }

  .doc-callout {
    position: relative; margin: 1.3em 0; padding: 15px 18px 15px 48px;
    border-radius: var(--radius); background: var(--accent-ground); break-inside: avoid;
    --tone: var(--accent);
  }
  .doc-callout::before {
    content: "i"; position: absolute; left: 17px; top: 17px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--tone); color: #fff; font: 700 12px/18px var(--doc-sans); text-align: center;
  }
  .doc-callout--warning { background: var(--doc-warn-ground); --tone: var(--doc-warn); }
  .doc-callout--warning::before { content: "!"; }
  .doc-callout--critical { background: var(--doc-bad-ground); --tone: var(--doc-bad); }
  .doc-callout--critical::before { content: "!"; border-radius: 0; width: 20px; left: 16px; clip-path: polygon(50% 0, 100% 100%, 0 100%); line-height: 21px; font-size: 11px; }
  .doc-callout > :first-child { margin-top: 0; }
  .doc-callout > :last-child { margin-bottom: 0; }
  .doc-callout > strong:first-child, .doc-callout > :is(h2, h3, h4):first-child {
    display: block; margin: 0 0 0.2em; color: var(--tone); font: 650 15px/1.45 var(--doc-sans); letter-spacing: 0; text-transform: none;
  }
  .doc-callout > :is(h2):first-child::before { display: none; }

  /* Summary: the one thing to read if you read nothing else. */
  .doc-summary { margin: 0 0 calc(2em * var(--flow)); font-size: 18px; line-height: 1.55; color: var(--doc-ink); text-wrap: pretty; break-inside: avoid; }
  .doc-summary::first-line { font-weight: 650; }

  .doc-card { margin: 1.2em 0; padding: 20px 22px; border: 1px solid var(--doc-line); border-radius: var(--radius); background: var(--doc-paper); break-inside: avoid; }
  .doc-card--tint { background: var(--doc-tint); border-color: transparent; }
  .doc-card--accent { background: var(--accent-ground); border-color: transparent; }
  .doc-card > :first-child { margin-top: 0; }
  .doc-card > :last-child { margin-bottom: 0; }
  .doc-card > :is(h2, h3):first-child { font: 650 16px/1.35 var(--doc-sans); letter-spacing: 0; margin-bottom: 0.45em; }
  .doc-card > h2:first-child::before { display: none; }

  .doc-badge {
    display: inline-flex; align-items: center; gap: 6px; vertical-align: 0.1em;
    padding: 1px 10px 1px 8px; border-radius: 999px; font: 650 12px/20px var(--doc-sans); white-space: nowrap;
    background: var(--doc-tint); color: var(--doc-ink-dim);
  }
  .doc-badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .doc-badge--accent { color: var(--accent); background: var(--accent-ground); }
  .doc-badge--ok { color: var(--doc-ok); background: var(--doc-ok-ground); }
  .doc-badge--warn { color: var(--doc-warn); background: var(--doc-warn-ground); }
  .doc-badge--bad { color: var(--doc-bad); background: var(--doc-bad-ground); }
  .doc-badge--bad::before { border-radius: 0; width: 8px; clip-path: polygon(50% 0, 100% 100%, 0 100%); }

  .doc-actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 1.1em 0 1.3em; break-inside: avoid; }
  a.doc-button {
    display: inline-flex; align-items: center; gap: 8px; padding: 11px 18px; border-radius: 999px;
    background: var(--doc-ink); color: #fff; font: 650 14.5px/1.3 var(--doc-sans); text-decoration: none; break-inside: avoid;
  }
  a.doc-button::after { content: "\2192"; font-family: var(--doc-sans); }
  a.doc-button--accent { background: var(--accent-fill); color: var(--doc-on-fill); }
  a.doc-button--quiet { background: transparent; color: var(--doc-ink); box-shadow: inset 0 0 0 1.5px var(--doc-edge); }

  .doc-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 32px; margin: 1.2em 0; }
  .doc-cols--wide-start { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
  .doc-cols--wide-end { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
  .doc-cols--three { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 24px; }
  .doc-cols > * { min-width: 0; }
  .doc-cols > * > :first-child, .doc-cols > :first-child { margin-top: 0; }

  /* Timeline: itineraries, agendas, programmes. <li class="is-key"> fills the dot. */
  .doc-timeline { list-style: none; padding: 0; margin: 1.2em 0 1.5em; }
  .doc-timeline > li { display: grid; grid-template-columns: 62px 22px minmax(0, 1fr); padding: 0; margin: 0; position: relative; break-inside: avoid; }
  .doc-timeline > li::before { content: ""; position: absolute; left: 72px; top: 14px; bottom: -8px; width: 1.5px; background: var(--doc-line); }
  .doc-timeline > li:last-child::before { display: none; }
  .doc-timeline > li::after { content: ""; position: absolute; left: 67px; top: 7px; width: 11px; height: 11px; border-radius: 50%; background: var(--doc-paper); box-shadow: inset 0 0 0 2px var(--accent-fill); }
  .doc-timeline > li.is-key::after { background: var(--accent-fill); }
  .doc-timeline time { grid-column: 1; font-weight: 650; font-size: 14px; line-height: 1.6; color: var(--doc-ink); white-space: nowrap; }
  .doc-timeline > li > div { grid-column: 3; padding-bottom: calc(16px * var(--flow)); }
  .doc-timeline > li > div > :last-child { margin-bottom: 0; }
  .doc-timeline > li > div > strong:first-child { display: block; }

  /* Steps: how-tos, recipes, setup guides. */
  .doc-steps { list-style: none; padding: 0; margin: 1.2em 0 1.5em; counter-reset: doc-step; }
  .doc-steps > li { counter-increment: doc-step; display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 0 14px; margin: 0 0 calc(18px * var(--flow)); padding: 0; break-inside: avoid; }
  .doc-steps > li::before {
    content: counter(doc-step); width: 32px; height: 32px; border-radius: 50%;
    background: var(--accent-ground); color: var(--accent); font: 700 15px/32px var(--doc-sans); text-align: center;
  }
  .doc-steps > li > :first-child { margin-top: 5px; }
  .doc-steps > li > :last-child { margin-bottom: 0; }

  /* Checklist: packing lists, action items. <li class="is-done"> ticks it. */
  .doc-checklist { list-style: none; padding: 0; margin: 0.8em 0 1.2em; }
  .doc-checklist > li { position: relative; padding-left: 28px; margin: 0.4em 0; break-inside: avoid; }
  .doc-checklist > li::before { content: ""; position: absolute; left: 0; top: 3px; width: 16px; height: 16px; border-radius: 4px; box-shadow: inset 0 0 0 1.5px var(--doc-edge); }
  .doc-checklist > li.is-done::before { background: var(--accent-fill); box-shadow: none; }
  .doc-checklist > li.is-done::after { content: ""; position: absolute; left: 5.5px; top: 5.5px; width: 4px; height: 8px; border: solid var(--doc-on-fill); border-width: 0 2px 2px 0; transform: rotate(45deg); }
  .doc-checklist > li.is-done { color: var(--doc-ink-mute); }

  /* Stats: headline figures. Optional .doc-delta--up / --down beneath. */
  .doc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 1.2em 0 1.6em; break-inside: avoid; }
  .doc-stats > div { background: var(--doc-tint); border-radius: var(--radius); padding: 16px 18px 15px; }
  .doc-stat-value { display: block; font-family: var(--doc-display); font-weight: var(--doc-display-weight); letter-spacing: var(--doc-display-track); font-size: 34px; line-height: 1.05; }
  .doc-stat-label { display: block; font-size: 13px; color: var(--doc-ink-mute); margin-top: 6px; }
  .doc-delta { display: inline-block; margin-top: 8px; font-size: 12.5px; font-weight: 650; }
  .doc-delta--up { color: var(--doc-ok); }
  .doc-delta--up::before { content: "+ "; }
  .doc-delta--down { color: var(--doc-bad); }

  /* Bars: <li style="--v: .72"><span>Label</span><b>72%</b></li>. --v is 0..1. */
  .doc-bars { list-style: none; padding: 0; margin: 1em 0 1.4em; break-inside: avoid; }
  .doc-bars > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; padding: 0; margin: 0 0 12px; font-size: 14px; }
  .doc-bars > li::after {
    content: ""; grid-column: 1 / -1; height: 8px; border-radius: 4px;
    background: linear-gradient(var(--accent-fill), var(--accent-fill)) 0 0 / calc(var(--v, 0) * 100%) 100% no-repeat, var(--doc-tint);
  }
  .doc-bars b { font-weight: 650; }

  /* Compare: options side by side. .is-pick marks the recommendation. */
  .doc-compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin: 1.2em 0 1.6em; }
  .doc-option { position: relative; padding: 20px 20px 18px; border-radius: var(--radius); box-shadow: inset 0 0 0 1px var(--doc-line); break-inside: avoid; }
  .doc-option.is-pick { box-shadow: inset 0 0 0 2px var(--accent-fill); background: var(--accent-wash); }
  .doc-option.is-pick::before { content: attr(data-label); position: absolute; top: -10px; left: 16px; padding: 0 9px; border-radius: 999px; background: var(--accent-fill); color: var(--doc-on-fill); font: 700 11px/20px var(--doc-sans); letter-spacing: 0.06em; text-transform: uppercase; }
  .doc-option.is-pick:not([data-label])::before { content: "Recommended"; }
  .doc-option > :first-child { margin-top: 0; }
  .doc-option > :last-child { margin-bottom: 0; }
  .doc-option h3 { font-size: 16px; margin-bottom: 2px; }
  .doc-price { display: block; font-family: var(--doc-display); font-weight: var(--doc-display-weight); letter-spacing: var(--doc-display-track); font-size: 26px; line-height: 1.2; margin: 6px 0 12px; }
  .doc-pros, .doc-cons { list-style: none; padding: 0; margin: 0 0 8px; font-size: 14px; }
  .doc-pros > li, .doc-cons > li { position: relative; padding-left: 20px; margin: 4px 0; }
  .doc-pros > li::before, .doc-cons > li::before { position: absolute; left: 0; font-weight: 700; width: 14px; text-align: center; }
  .doc-pros > li::before { content: "+"; color: var(--doc-ok); }
  .doc-cons > li::before { content: "\2013"; color: var(--doc-bad); }

  /* Line items: invoices, quotes, budgets. tfoot rows are the totals. */
  table.doc-lines td:not(:first-child), table.doc-lines th:not(:first-child) { text-align: right; white-space: nowrap; }
  table.doc-lines tfoot td { border-bottom: 0; padding-top: 6px; padding-bottom: 6px; }
  table.doc-lines tfoot tr:first-child td { border-top: 1.5px solid var(--doc-ink); padding-top: 12px; }
  table.doc-lines tfoot tr.doc-total td { font-size: 19px; font-weight: 700; padding-top: 10px; }
  table.doc-lines tfoot tr.doc-total td:last-child { color: var(--accent); }

  .doc-quote { margin: 1.6em 0; padding: 0; border: 0; break-inside: avoid; }
  .doc-quote > p { font-family: var(--doc-display); font-weight: var(--doc-display-weight); letter-spacing: var(--doc-display-track); font-size: 24px; line-height: 1.3; color: var(--doc-ink); margin: 0; }
  .doc-quote > p::before { content: "\201C"; color: var(--accent-fill); margin-left: -0.45em; }
  .doc-quote > p::after { content: "\201D"; color: var(--accent-fill); }
  .doc-quote > footer { margin-top: 10px; font-size: 13px; color: var(--doc-ink-mute); }

  .doc-fineprint { margin-top: calc(2.4em * var(--flow)); padding-top: 14px; border-top: 1px solid var(--doc-line); font-size: 12.5px; line-height: 1.5; color: var(--doc-ink-mute); }
  .doc-fineprint > :last-child { margin-bottom: 0; }

  .doc-page-break { break-before: page; }
  .doc-keep { break-inside: avoid; }

  @media (max-width: 600px) {
    .doc-cols, .doc-cols--wide-start, .doc-cols--wide-end, .doc-cols--three { grid-template-columns: minmax(0, 1fr); }
    .doc-hero--split { grid-template-columns: minmax(0, 1fr); padding-right: var(--gutter); }
    .doc-hero--split .doc-hero-image { order: -1; width: calc(100% + 2 * var(--gutter)); min-height: 0; aspect-ratio: 16 / 10; margin: 0 calc(-1 * var(--gutter)); }
    body > .doc-hero--split:first-child .doc-hero-text { padding-top: 28px; }
    .doc-hero h1 { font-size: 34px; }
    .doc-hero--cover { min-height: 0; justify-content: flex-start; }
    .doc-hero--cover > .doc-hero-image { position: static; order: -1; width: calc(100% + 2 * var(--gutter)); height: auto; aspect-ratio: 16 / 10; margin: calc(-1 * (var(--page-top) + 40px)) calc(-1 * var(--gutter)) 28px; }
    .doc-hero--cover h1 { font-size: 44px; }
    .doc-letterhead address { text-align: left; }
  }
  @media print { pre, blockquote { break-inside: avoid; } }

  body > *:first-child { margin-top: 0; }
  body > *:last-child { margin-bottom: 0; }
}
`;

/** `s` as a CSS string literal that cannot end the string, or the `<style>` element it sits in. */
function cssString(s: string): string {
  const escaped = [...s.replace(/\s+/g, " ")]
    .map((ch) => (/[\w .,:;!?'()&+\-/]/.test(ch) ? ch : `\\${ch.codePointAt(0)!.toString(16).padStart(6, "0")}`))
    .join("");
  return `"${escaped}"`;
}

/**
 * The PDF footer, as CSS margin boxes: the running title bottom left, "2 / 5"
 * bottom right, on every page but the first. Margin boxes rather than
 * Puppeteer's `displayHeaderFooter`, whose footer goes missing when the first
 * page's margins differ from the rest (puppeteer#2480), as they do here, and
 * whose template shares no fonts or styles with the page. Screen output (PNG)
 * never shows them.
 */
export function pageFooter(runningTitle?: string): string {
  const box = "font: 10px/1.2 system-ui, -apple-system, \"Segoe UI\", Roboto, \"Noto Sans\", \"Liberation Sans\", Arial, sans-serif; color: #5f584c;";
  const title = runningTitle?.trim();
  return String.raw`
@layer brain-document {
  @page {
    @bottom-left { content: ${title ? cssString(title) : '""'}; ${box} padding-left: 18mm; vertical-align: middle; }
    @bottom-right { content: counter(page) " / " counter(pages); ${box} padding-right: 18mm; vertical-align: middle; }
  }
  @page :first { @bottom-left { content: none; } @bottom-right { content: none; } }
  @page doc-cover { @bottom-left { content: none; } @bottom-right { content: none; } }
}
`;
}
