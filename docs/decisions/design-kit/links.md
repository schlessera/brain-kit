# Design kit — Links

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-28--d48-a-model-authored-link-shows-its-destination-and-brain-never-opens-it-43"></a>

## 2026-09-28 — D48: a model-authored link shows its destination, and Brain never opens it (#43)

**Ruled 2026-09-28, before implementation.** This entry records the ruling
and its reasons. The PR that builds it appends what building it found, the
way D41's "Built" note does, and supersedes a point here if the code
disagrees.

**Question.** `LinkPreviewCard` is in the kit and D41 §2 left it out of
`show_block`, because its props carried no URL (`LinkPreviewCardProps`,
`packages/ui-kit/src/blocks/LinkPreviewCard.tsx:67-97`, where they now do). Giving it one is not
just a missing prop. The model chooses the URL, the title and the
description, and it may have read untrusted content before choosing them. A
card like that, drawn inside an answer the user trusts, is a phishing shape:
a model-chosen title over a destination the user cannot see.

**Ruling (maintainer, recorded on #43).** A `link` block that shows where it
goes and fetches nothing.

1. **The boundary.** Only absolute `http:`/`https:` URLs are accepted.
   Embedded credentials and every other scheme are refused. The displayed
   host comes from the same validated URL the anchor navigates to, never from
   a model-supplied field. The host is visible before any click, and the full
   URL can be inspected. Title and description are shown as the model's
   words, not as page metadata. No title, favicon, image or destination
   content is fetched, and navigation happens only on an explicit user
   activation of the Open anchor.
2. **One classifier, `classifyLink`, pure and in the kit.** It lives in
   ui-kit behind a React-free subpath export, `@schlessera/brain-ui-kit/links`.
   It does no I/O, no DNS and no `window`. Raw-string checks run before the
   WHATWG parser, so a tab or a bidi control the parser would silently strip is
   refused rather than cleaned. Its refusal reasons are `unparseable`,
   `relative`, `scheme`, `credentials`, `mixed-script`, `hidden-characters`
   and `too-long`.
3. **The kit takes `url` and derives everything itself.** `LinkPreviewCard`
   gains `url`, `description`, `expanded`, `onExpandedChange` and `onCopy`.
   With `url` present, it calls `classifyLink` and draws either the
   destination card or the Link withheld card, so the host on screen and the
   `href` always come from one parse, even for a consumer that is not the
   block renderer. The payload is `{ kind: "link", url, title?, description? }`
   and mirrors the props, so D41 §4 holds unamended. The attribution line
   ("Title and summary by the brain · page not opened or checked") is fixed
   kit text, not a payload field.
4. **A policy refusal rejects the `show_block` call**, with the reason, the
   same way a schema failure does, so the model can correct itself. D41 §1's
   "the handler validates and echoes" stays true: every echoed payload is
   valid. The client classifies again anyway, and draws Link withheld for
   anything that still fails, such as a replayed transcript or a payload
   written under a looser policy. The withheld card is the fail-closed
   fallback, not the normal refusal path.
5. **The ASCII host is the headline.** The `xn--` form is what the browser
   resolves, and with no confusables table it is the only defence against an
   all-Cyrillic lookalike, which passes the UTS #39 Highly Restrictive check.
   `reads as …` is the secondary line. A label that mixes scripts, and any
   default-ignorable or bidi-control code point, is refused. Other IDNs are
   not refused wholesale.
6. **A new package edge: ui-sdk → ui-kit.** The `show_block` handler
   (`handleShowBlock`, `packages/ui-sdk/src/server/bridge-tools/show-block.ts:29-52`)
   has to call `classifyLink`, and the two packages did not depend on each other. ui-sdk
   takes a workspace dependency on ui-kit, and only on its React-free `links`
   export. That gives one implementation and one test suite. The edge goes
   through the `release` skill's checks.

**Alternatives refused.**

- *A fetched preview* (title, favicon, image from the destination): it is an
  egress channel opened on the model's say-so, plus a caching and
  failure-handling service. The renderer is denied every egress channel, and
  this would be the first hole. If a real preview is ever wanted, it gets its
  own issue and its own egress discussion.
- *A model-supplied `host` or `source` field*: a field that can disagree with
  the URL is a field that can lie.
- *Echoing a refused payload with a note in the tool result*, the spec's
  first draft: the model learns nothing it can act on, and the reader gets a
  withheld card for a mistake the model could have fixed.
- *The classifier in ui-sdk, with the kit receiving derived strings*: a kit
  consumer that is not the block renderer could then show a host that did not
  come from the `href`.
- *A "mentions another site" note* (a title naming `paypal.com` over a link
  to another host): detecting a hostname needs a TLD list that goes stale, and
  a heuristic that misses a case reads as "the title matches the
  destination", which is exactly what nothing on the card may imply.
- *Registrable-domain emphasis*: it needs the Public Suffix List, a bundled
  dataset that goes stale, and a wrong guess (bolding `co.uk`) is worse than
  none.
- *A confirm dialog after Open*: the anchor is the explicit act, and a second
  yes is one the reader learns to skip.

**Not decided here.** Markdown links in prose are D49. Links in a shared PNG
or PDF are #558.

**Built 2026-09-28 (#43).** The build held to the ruling above. What it
found, and what the ruling did not say:

- **Where each part landed.** The handler throws with the reason
  (`handleShowBlock`, `packages/ui-sdk/src/server/bridge-tools/show-block.ts:29-52`).
  The payload parse on the client stays structural, and the card classifies
  again. The card's link mode calls `classifyLink` itself
  (`LinkCard`, `packages/ui-kit/src/blocks/LinkPreviewCard.tsx:294-512`), and
  there is no `host` prop and no `host` field. The payload
  (`LINK_BLOCK_SCHEMA`, `packages/ui-sdk/src/tool-contracts/blocks.ts:429-449`)
  mirrors the props. `classifyLink` (`classifyLink`, `packages/render-template/src/links.ts:252-311`)
  is pure. The edge table records the new dependency
  (`"@schlessera/brain-ui-sdk"`, `tests/allowed-edges.ts:70`), and ui-kit now
  builds and publishes ahead of ui-sdk. At that point the kit's own row was unchanged.
  #558 later moved the pure classifier to the template's `./links` leaf and
  added the kit-to-template edge; D13's purity gate still holds.
- **One reading of the spec, stated.** The spec says "UTS #39 Highly
  Restrictive" and lists the allowed mixes as Han with Hiragana and Katakana,
  with Bopomofo, and with Hangul. UTS #39 includes Latin in each of those
  three sets, so a Japanese brand name with Latin letters in it is not
  refused. The implementation follows the standard
  (`ALLOWED_MIXES`, `packages/render-template/src/links.ts:215-219`). Latin with any
  other script (Cyrillic, Greek, …) is still refused.
- **How "nothing is fetched" is proved, and its measured blind spot.** The
  browser test reads every request from Playwright on the Node side
  (`startRequestLog`, `packages/ui-kit/tests/visual/request-log.ts:20-32`),
  across the whole browser context so a new tab is seen. An in-page spy
  misses an `<img>` and a navigation, and Resource Timing misses a failed
  request, which is every request to `.example`. Mutating a `/preview.png`
  image or a scripted prefetch into the card turns the test red on that log.
  A `/favicon.ico` image did not: Chromium routes it so that Playwright
  reports no request. So the test also asserts that the card contains no
  element or style that can load anything, and that assertion is the one
  that fails for the favicon.
- **One more alternative refused.** *Take a derived `destination` prop* (the
  spec's §8): the kit would trust its caller for the host, and the payload
  would stop mirroring the props.

<a id="2026-09-28--d49-a-prose-link-goes-through-d48s-classifier-on-every-markdown-surface-and-mailto-stays-live-551"></a>

## 2026-09-28 — D49: a prose link goes through D48's classifier on every markdown surface, and `mailto:` stays live (#551)

**Ruled 2026-09-28, before implementation.** As with D48, the implementing PR
appends what building it found. The presentation (how the host sits in
running text, and how a withheld link reads) is still to be designed on the
issue, so this entry fixes the behaviour and not the look.

**Question.** D48 puts every model-authored link card behind `classifyLink`.
A markdown link in the answer's prose gets none of it. The `a` override
(`a: ({ href`, `packages/ui-react/src/components/chat/brain-markdown.tsx:170-181`)
draws every link that is not a repo path as a bare
`<a target="_blank" rel="noopener noreferrer">`. The only filter is
react-markdown's default `urlTransform`, which strips `javascript:` and
`data:` and nothing else. So `[your bank](https://account-check.example)`
shows "your bank" with no destination: D48's phishing shape, one layer down,
in the place it is easiest to produce.

**Ruling (maintainer, recorded on #551).**

1. **One policy.** Every anchor the override draws, apart from repo
   `FileLink`/`DirLink` links, goes through `classifyLink`. There is no
   second URL parser and no prose-specific loosening of the web rules, so a
   prose link and a link card never disagree about the same URL.
2. **Every `BrainMarkdown` surface, not just answers.** The override is
   shared by answers, share blocks, `ask_user` cards, the briefing and the
   file viewer. All are covered, because the corpus holds clipped external
   content, and a note is no safer to click than an answer. `remark-gfm`
   autolinks are covered too.
3. **An accepted link shows its host.** The text stays the anchor text, and
   the verdict's ASCII host sits beside it, e.g.
   `your bank (account-check.example)`. The `href` and the host come from the
   same verdict. The anchor gets `rel="noopener noreferrer nofollow"` and
   `referrerpolicy="no-referrer"`.
4. **A refused link is inert.** It is plain text: no `<a>`, no
   `role="link"`, nothing that navigates, and no later pass may promote it
   back into a link.
5. **`mailto:` is the one prose-only exception.** It stays a live anchor,
   with the address from the same parse shown beside its text. The raw-string
   checks still run first, and a failure makes it inert. It is a named check
   beside `classifyLink` in the same `links` module, with its own tests, and
   not a loosening of `classifyLink`: the `link` block still refuses
   `mailto:`. Every other scheme `classifyLink` refuses (`xmpp:`, `irc:`, …)
   is inert.

**Alternatives refused.**

- *Leave prose links as they are, with the block as the supported way to
  show a link*: it leaves D48's threat open in the one place a model reaches
  for without being asked.
- *Stop rendering prose anchors, and tell the model to use the `link`
  block*: it kills every link in the user's own notes along with the
  model's, and it leans on prompt text, the lever D42 measured at 0 of 5.
- *Only model-authored surfaces, with the file viewer keeping plain
  anchors*: it needs a prop saying who wrote the text, and clipped pages in
  the corpus are no more trustworthy than an answer.
- *Inert `mailto:` like every other refused scheme*: an email address in a
  note is ordinary content, and showing the address beside the text already
  answers what the link does.

**Not a contract change.** Prose rendering is not in
`docs/integration-contract.md`.

**Not decided here.** A shared PNG or PDF draws links with `marked` in
`render-template` (D46), not through this override, so it keeps
hidden-destination links until #558 is ruled. "Copy as rich text" copies the
rendered DOM, so it inherits this treatment.

**Built 2026-09-28 (#551).** The presentation is the design comment on
#551, approved there, and the build held to it and to the ruling above. What
it found, and what neither said:

- **Where each part landed.** Every non-repo anchor the override draws is a
  `ProseLink` (`ProseLink`, `packages/ui-react/src/components/chat/prose-link.tsx:27-57`),
  which makes the one `classifyLink` or `classifyMailto` call its `href` and
  its host both come from. The mail check sits beside `classifyLink`
  (`classifyMailto`, `packages/render-template/src/links.ts:371-405`), and the
  streaming hold is a pure function applied to the answer's last text part
  while it streams (`holdOpenLink`, `packages/ui-react/src/lib/stream-link-hold.ts:104-112`).
- **The override never saw what the author sent.** mdast-util-to-hast
  percent-encodes a link's URL before react-markdown's `urlTransform` blanks
  any scheme it dislikes. A U+202E in a path arrived as `%E2%80%AE`, which
  `classifyLink` accepts, and `javascript:` arrived as `""`, which reads as
  relative. A remark plugin now carries the address as written beside the
  `href` (`remarkRawHref`, `packages/ui-react/src/components/chat/prose-link.tsx:156-178`),
  and a reference link takes its definition's. Deleting the plugin from the
  list turns the refused-link tests red.
- **Chrome breaks a host at a `-`.** A `<wbr>` after each "." adds break
  opportunities but removes none, and real Chrome at 288px broke
  `harbour-master` at its hyphen. Each label is an inline block, as the
  card's host is (`.bk-plink-label`, `packages/ui-react/src/theme.css:334-338`),
  with "(" in the first label and ")" in the last. Only a label wider than
  the line wraps within itself.
- **A mail address's local part is ASCII `dot-atom`.** The design gave the
  domain the web host's rules and said nothing of the local part beyond
  hidden characters. A non-ASCII local part is refused as `unparseable`,
  because there is no ASCII form to show for it. The domain goes through
  `classifyLink` itself, as the host of an `https:` address.
- **A withheld link's text inherits its ink** rather than taking
  `--bk-color-ink`, so inside an amber `h2` or a dim `em` it still reads as
  the words around it. In a paragraph the two are the same colour, which the
  Chrome test asserts.
- **Link text is never linkified, accepted or withheld.** The text passes
  that turn repo paths and wikilinks into links stand down inside any prose
  link (`withTextProcessing`, `packages/ui-react/src/components/chat/brain-markdown.tsx:47-57`),
  because an anchor inside an anchor is not HTML either. The same wrapper
  had been writing react-markdown's `node` object into the DOM as
  `node="[object Object]"`, and no longer does.
- **Three edges the design did not list.** A markdown link title is dropped:
  it was the author's words in a hover-only tooltip. The streaming hold also
  holds a closed `[text]` that ends the buffer, since `(` may be the next
  token, and an image's `!` goes with its `[`. The `bk-sr` class the design
  names did not exist, and is defined beside the link rules.
- **How "nothing is fetched" is proved.** In real Chrome, Puppeteer's
  `request` event and the browser's `targetcreated` event see nothing while
  the fixture renders, every link is hovered and every withheld link is
  clicked. Clicking an accepted link then opens a tab to its destination,
  which the same listeners see, so the harness is shown able to observe what
  the first half says never happens.

**Print/export treatment, 2026-09-30 (#558).** The same pure verdict now owns
app export hrefs and visible ASCII hosts or validated mail addresses. Relative
repo/file targets stay inert with readable target information; safe local
fragments retain local navigation without inventing a host. Mail queries are
stripped. The no-referrer/rel treatment is retained. Markdown link tokens keep
their original addresses until classification, before URI encoding can conceal
raw controls; HTML entities are resolved structurally. Parser-located href
attributes preserve literal/numeric NULs before HTML can replace them, and
autolinks use the classifier's redacted display after raw refusal. Classification rules,
including accepted percent-encoded web paths, are unchanged.

Print uses the approved parenthesised, monospace destination, one wrapping DNS
label at a time and no ellipsis, with a 12px print legibility floor. Exact plain destination text keeps the D49
redundancy rule, while its text is still protected against supplied CSS. An
existing suffix is rebuilt from the current verdict, so repeated processing
does not duplicate labels and source-supplied markers cannot bypass policy.
The renderer verifies disclosure in the final media mode and finished PDF; HTML attributes alone
do not prove PDF safety. See the D46 addition above for alternate markup,
isolation, failure behavior and runtime proof.
