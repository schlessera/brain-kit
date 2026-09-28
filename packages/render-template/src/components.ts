/**
 * The document components: every class the stylesheet gives meaning to, and a
 * minimal snippet for each block.
 *
 * This list is the contract `STYLES` implements (#530). A test holds the two
 * to each other in both directions, `lintDocument` checks authored markup
 * against it, and `brain render --blocks` prints the snippets, so an agent
 * composing a document copies markup from here instead of writing CSS.
 */

/** The accents a document may pick with `<body data-accent="…">`. Default amber. */
export const ACCENTS = ["amber", "teal", "blue", "purple", "graphite"] as const;
export type Accent = (typeof ACCENTS)[number];

export interface DocumentBlock {
  name: string;
  /** An opener comes first and bleeds to the page edge; a block sits in the flow. */
  group: "opener" | "block";
  /** Every class this block introduces. */
  classes: readonly string[];
  /** When to reach for it, in one line. */
  use: string;
  /** The smallest markup that shows every part. */
  html: string;
}

export const DOCUMENT_BLOCKS: readonly DocumentBlock[] = [
  {
    name: "hero",
    group: "opener",
    classes: ["doc-hero", "doc-eyebrow", "doc-hero-image"],
    use: "Band opener: eyebrow, title, one-sentence dek, optional facts and a full-bleed image.",
    html: `<header class="doc-hero">
  <div class="doc-eyebrow"><span>Day plan</span><span>Sunday 12 July</span></div>
  <h1>Title</h1>
  <p>One sentence that says what this is.</p>
  <dl class="doc-kv doc-kv--facts"><div><dt>Label</dt><dd>Value<small>Sub-line</small></dd></div></dl>
  <img class="doc-hero-image" src="data:…" alt="What the photo shows">
</header>`,
  },
  {
    name: "hero--solid",
    group: "opener",
    classes: ["doc-hero--solid"],
    use: "The accent fill as the ground. Reports, announcements.",
    html: `<header class="doc-hero doc-hero--solid">
  <div class="doc-eyebrow"><span>Monthly report</span><span>July</span></div>
  <h1>Title</h1>
  <p>One sentence.</p>
</header>`,
  },
  {
    name: "hero--split",
    group: "opener",
    classes: ["doc-hero--split", "doc-hero-text"],
    use: "Text beside a full-height image. Recipes, places, profiles. Needs an image.",
    html: `<header class="doc-hero doc-hero--split">
  <div class="doc-hero-text">
    <div class="doc-eyebrow"><span>How-to</span></div>
    <h1>Title</h1>
    <p>One sentence.</p>
  </div>
  <img class="doc-hero-image" src="data:…" alt="What the photo shows">
</header>`,
  },
  {
    name: "hero--cover",
    group: "opener",
    classes: ["doc-hero--cover"],
    use: "A whole first page, then the content. Invitations, programmes, proposals.",
    html: `<header class="doc-hero doc-hero--cover">
  <img class="doc-hero-image" src="data:…" alt="What the photo shows">
  <div class="doc-eyebrow"><span>You're invited</span></div>
  <h1>Title</h1>
  <p>Where and when, in one sentence.</p>
</header>`,
  },
  {
    name: "letterhead",
    group: "opener",
    classes: ["doc-letterhead", "doc-mark"],
    use: "A compact top line. Letters, memos, invoices. Follow it with an h1.",
    html: `<header class="doc-letterhead">
  <div class="doc-mark">Sender<small>What this is</small></div>
  <address>Reference · date<br>Second line</address>
</header>`,
  },
  {
    name: "kv",
    group: "block",
    classes: ["doc-kv"],
    use: "Label and value pairs. A <div> around each pair is optional.",
    html: `<dl class="doc-kv"><dt>Check-in</dt><dd>From 15:00</dd><dt>Reference</dt><dd>2026-041</dd></dl>`,
  },
  {
    name: "kv--facts",
    group: "block",
    classes: ["doc-kv--facts"],
    use: "A row of labelled headline figures with a top rule. <small> adds a sub-line.",
    html: `<dl class="doc-kv doc-kv--facts">
  <div><dt>Walk</dt><dd>11.4 km<small>About 3½ h</small></dd></div>
  <div><dt>Drive</dt><dd>35 min</dd></div>
</dl>`,
  },
  {
    name: "kv--row",
    group: "block",
    classes: ["doc-kv--row"],
    use: "Pairs on one wrapping line. Memo headers: for, from, decision by.",
    html: `<dl class="doc-kv doc-kv--row"><div><dt>For</dt><dd>The team</dd></div><div><dt>Decision by</dt><dd>Friday</dd></div></dl>`,
  },
  {
    name: "kv--stacked",
    group: "block",
    classes: ["doc-kv--stacked"],
    use: "Each label above its value. Narrow cards and columns.",
    html: `<dl class="doc-kv doc-kv--stacked"><dt>Label</dt><dd>Value</dd><dt>Label</dt><dd>Value</dd></dl>`,
  },
  {
    name: "callout",
    group: "block",
    classes: ["doc-callout", "doc-callout--warning", "doc-callout--critical"],
    use: "Info (plain), warning or critical. The first <strong> is the title.",
    html: `<div class="doc-callout"><strong>Title</strong>What to know.</div>
<div class="doc-callout doc-callout--warning"><strong>Title</strong>What to watch.</div>
<div class="doc-callout doc-callout--critical"><strong>Title</strong>What is wrong.</div>`,
  },
  {
    name: "summary",
    group: "block",
    classes: ["doc-summary"],
    use: "The one paragraph to read if you read nothing else. Its first line is bold.",
    html: `<p class="doc-summary">We recommend X, because Y.</p>`,
  },
  {
    name: "card",
    group: "block",
    classes: ["doc-card", "doc-card--tint", "doc-card--accent"],
    use: "A boxed group. Hairline, tint (warm ground) or accent ground.",
    html: `<div class="doc-card"><h3>Title</h3><p>Content.</p></div>
<div class="doc-card doc-card--tint"><h3>Title</h3><p>Content.</p></div>
<div class="doc-card doc-card--accent"><h3>Title</h3><p>Content.</p></div>`,
  },
  {
    name: "badge",
    group: "block",
    classes: ["doc-badge", "doc-badge--accent", "doc-badge--ok", "doc-badge--warn", "doc-badge--bad"],
    use: "A status in words, inline. Plain, accent, ok, warn or bad.",
    html: `<span class="doc-badge">Draft</span> <span class="doc-badge doc-badge--accent">New</span> <span class="doc-badge doc-badge--ok">Confirmed</span> <span class="doc-badge doc-badge--warn">Due Friday</span> <span class="doc-badge doc-badge--bad">Overdue</span>`,
  },
  {
    name: "actions",
    group: "block",
    classes: ["doc-actions", "doc-button", "doc-button--accent", "doc-button--quiet"],
    use: "A row of pill links. One --accent for the primary call to action, the rest --quiet.",
    html: `<div class="doc-actions">
  <a class="doc-button doc-button--accent" href="https://…">Primary</a>
  <a class="doc-button doc-button--quiet" href="https://…">Secondary</a>
</div>`,
  },
  {
    name: "cols",
    group: "block",
    classes: ["doc-cols", "doc-cols--wide-start", "doc-cols--wide-end", "doc-cols--three"],
    use: "Two columns (1:1, 3:2 or 2:3) or three. One column under 600px.",
    html: `<div class="doc-cols"><div>Half</div><div>Half</div></div>
<div class="doc-cols doc-cols--wide-start"><div>Wide</div><div>Narrow</div></div>
<div class="doc-cols doc-cols--wide-end"><div>Narrow</div><div>Wide</div></div>
<div class="doc-cols doc-cols--three"><div>Third</div><div>Third</div><div>Third</div></div>`,
  },
  {
    name: "timeline",
    group: "block",
    classes: ["doc-timeline", "is-key"],
    use: "Times down the left, a dotted line, what happens. is-key fills the dot.",
    html: `<ol class="doc-timeline">
  <li><time>09:00</time><div><strong>What</strong>Detail.</div></li>
  <li class="is-key"><time>11:30</time><div><strong>The key moment</strong>Detail.</div></li>
</ol>`,
  },
  {
    name: "steps",
    group: "block",
    classes: ["doc-steps"],
    use: "Numbered instructions with large counters. How-tos, recipes, setup.",
    html: `<ol class="doc-steps">
  <li><p><strong>Do this.</strong> Detail.</p></li>
  <li><p><strong>Then this.</strong> Detail.</p></li>
</ol>`,
  },
  {
    name: "checklist",
    group: "block",
    classes: ["doc-checklist", "is-done"],
    use: "Boxes to tick. is-done ticks one. Packing lists, next steps, ingredients.",
    html: `<ul class="doc-checklist"><li class="is-done">Done already</li><li>Still to do</li></ul>`,
  },
  {
    name: "stats",
    group: "block",
    classes: ["doc-stats", "doc-stat-value", "doc-stat-label", "doc-delta", "doc-delta--up", "doc-delta--down"],
    use: "Headline figures in tiles, each with an optional change beneath.",
    html: `<div class="doc-stats">
  <div><span class="doc-stat-value">4,812</span><span class="doc-stat-label">Accounts</span><span class="doc-delta doc-delta--up">12% vs June</span></div>
  <div><span class="doc-stat-value">€6.9k</span><span class="doc-stat-label">Hosting</span><span class="doc-delta doc-delta--down">21% over budget</span></div>
  <div><span class="doc-stat-value">2.1%</span><span class="doc-stat-label">Churn</span><span class="doc-delta">Flat</span></div>
</div>`,
  },
  {
    name: "bars",
    group: "block",
    classes: ["doc-bars"],
    use: "Horizontal bars. --v is the share, 0 to 1. The only inline style an agent writes.",
    html: `<ul class="doc-bars">
  <li style="--v:.46"><span>Label</span><b>46%</b></li>
  <li style="--v:.27"><span>Label</span><b>27%</b></li>
</ul>`,
  },
  {
    name: "compare",
    group: "block",
    classes: ["doc-compare", "doc-option", "is-pick", "doc-price", "doc-pros", "doc-cons"],
    use: "Options side by side. is-pick marks the recommendation; data-label renames its tag.",
    html: `<div class="doc-compare">
  <div class="doc-option"><h3>Option A</h3><small>Context</small><span class="doc-price">€14,200</span>
    <ul class="doc-pros"><li>Upside</li></ul><ul class="doc-cons"><li>Downside</li></ul></div>
  <div class="doc-option is-pick" data-label="Our pick"><h3>Option B</h3><span class="doc-price">€16,800</span>
    <ul class="doc-pros"><li>Upside</li></ul></div>
</div>`,
  },
  {
    name: "lines",
    group: "block",
    classes: ["doc-lines", "doc-total"],
    use: "Line items with right-aligned figures. tfoot holds the totals; doc-total is the last.",
    html: `<table class="doc-lines">
  <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
  <tbody><tr><td><strong>Item</strong><br><small>Detail</small></td><td>6</td><td>€280</td><td>€1,680.00</td></tr></tbody>
  <tfoot><tr><td>Subtotal</td><td></td><td></td><td>€1,680.00</td></tr>
    <tr class="doc-total"><td>Total due</td><td></td><td></td><td>€1,680.00</td></tr></tfoot>
</table>`,
  },
  {
    name: "table",
    group: "block",
    classes: ["num"],
    use: "A plain table needs no class: hairline rows under an uppercase header. class=\"num\" right-aligns a figure.",
    html: `<table><thead><tr><th>Plan</th><th class="num">Accounts</th></tr></thead>
<tbody><tr><td>Free</td><td class="num">3,120</td></tr></tbody></table>`,
  },
  {
    name: "zebra",
    group: "block",
    classes: ["doc-zebra"],
    use: "A striped table, for rows read across a wide table.",
    html: `<table class="doc-zebra"><thead><tr><th>Plan</th><th class="num">Accounts</th></tr></thead>
<tbody><tr><td>Free</td><td class="num">3,120</td></tr></tbody></table>`,
  },
  {
    name: "quote",
    group: "block",
    classes: ["doc-quote"],
    use: "A pull quote in display type, with its source.",
    html: `<figure class="doc-quote"><p>The sentence worth quoting.</p><footer>Who said it</footer></figure>`,
  },
  {
    name: "fineprint",
    group: "block",
    classes: ["doc-fineprint"],
    use: "Sources, terms and small notes, last on the page.",
    html: `<div class="doc-fineprint">Figures from the July export.</div>`,
  },
  {
    name: "numbered-heading",
    group: "block",
    classes: ["doc-n"],
    use: "An 01 / 02 / 03 kicker on an h2. Memos and briefs.",
    html: `<h2><span class="doc-n">01</span>Why now</h2>`,
  },
  {
    name: "page-control",
    group: "block",
    classes: ["doc-page-break", "doc-keep"],
    use: "Force a new PDF page before an element, or keep a group on one page.",
    html: `<section class="doc-page-break">…</section>
<div class="doc-keep">…</div>`,
  },
];

/** Classes set on `<body>`. */
export const SWITCH_CLASSES = ["doc--editorial", "doc--compact"] as const;

/** Classes the shell or the markdown pipeline emits itself; authors rarely write them. */
const SHELL_CLASSES = ["remote-image", "mermaid-figure"] as const;

/** Every class the stylesheet styles. The CSS contract of #530. */
export const DOCUMENT_CLASSES: readonly string[] = [
  ...new Set<string>([
    ...SWITCH_CLASSES,
    ...DOCUMENT_BLOCKS.flatMap((b) => b.classes),
    ...SHELL_CLASSES,
  ]),
].sort();

/** The opener classes, of which a document has at most one, first in `<body>`. */
export const OPENER_CLASSES = ["doc-hero", "doc-letterhead"] as const;
