# The DC runtime, and its exact React equivalent

Source: `support.js` from the design drop (the session scratchpad's `design/`
directory). 1,911 lines, generated from a `dc-runtime/src/*.ts` build. This
document is the contract the porting agents work from: every construct the 56
`*.dc.html` kit files use, what the runtime actually does with it, and the JSX
that reproduces it.

**The two copies are byte-identical.** `design/support.js` and
`design/kit/support.js` are both 69,150 bytes, md5
`951ae391b8ae72ef12e671c2fad23353`, and `cmp` reports no difference. There is
one runtime, not two.

Runtime substrate: React **18.3.1 UMD** loaded from unpkg with SRI, plus
`@babel/standalone` 7.29.0 loaded lazily and only for `x-import` of `.jsx`/`.tsx`
(never used by this kit). The kit is written against React 18 class-component
semantics.

---

## 1. `DCLogic` — what it is and when it runs

`window.DCLogic` and `window.StreamableLogic` are the **same class**
(`StreamableLogic` in `src/logic.ts`). Its whole surface:

```js
class StreamableLogic {
  props = {};            // set in the constructor from the host
  state = {};            // plain object, NOT React state
  __host;                // back-pointer to the React host, installed after construction
  setState(update, cb)   // delegates to host.__setLogicState
  forceUpdate()          // delegates to host.forceUpdate
  componentDidMount() {}
  componentDidUpdate(prevProps) {}
  componentWillUnmount() {}
  renderVals() { return {}; }   // the flat object the template renders against
}
```

### How the author's class is loaded

The `<script type="text/x-dc" data-dc-script>` body is evaluated with

```js
new Function("DCLogic", "StreamableLogic", "React",
  src + ';return (typeof Component!=="undefined"&&Component)||undefined;')
```

so the script **must** define `class Component extends DCLogic`. `React` is in
scope but no kit file uses it. Eval failure is not fatal: the template still
renders, against props alone, with a red error banner.

### The React host

Every DC is rendered by `StreamableComponent`, a real `React.Component`:

| Host event | What happens to the logic instance |
|---|---|
| construct | `new Logic(userProps)`, then `logic.__host = this` |
| every `render()` | `logic.props = userProps`; `vals = { ...userProps, ...logic.renderVals() ?? {} }`; then `tpl(vals, this)` |
| `componentDidMount` | `logic.componentDidMount()` (try/caught) |
| `componentDidUpdate(prev)` | `logic.props = userProps` **first**, then `logic.componentDidUpdate(prev)` |
| `componentWillUnmount` | `logic.componentWillUnmount()` |
| `logic.setState(patch, cb)` | `logic.state = { ...prev, ...patch }`, then host `setState(s => ({ __v: s.__v + 1 }), cb)` |

Four consequences that matter for the port:

1. **`renderVals()` runs on every render**, unmemoized. Every style object it
   returns is a fresh identity each time. Porting it verbatim is correct;
   hoisting the static halves out of the function body is a safe improvement,
   not a required one.
2. **`renderVals()` output is merged *over* props.** A key returned by
   `renderVals()` shadows the prop of the same name. `Disclosure` relies on this
   (`open`), as does every component that returns `children`.
3. **`state` is not React state.** `setState` mutates `logic.state` synchronously
   and then bumps a counter on the host to force a re-render. The functional form
   `setState(prev => patch)` is supported.
4. Each DC is its own **error boundary** (`getDerivedStateFromError`). A throw
   anywhere in its subtree renders a red `.sc-logic-error` box plus a grey
   placeholder instead of unmounting the page.

### Who uses state and lifecycle in this kit

Verified by grep across all 56 components:

- **`this.state` / `setState`: `Disclosure.dc.html` only.**
- **Lifecycle hooks: `Icon.dc.html` only** (`componentDidMount`,
  `componentDidUpdate`, `componentWillUnmount`, all to re-run
  `window.lucide.createIcons()`).
- **`window` / `document` / `fetch` / `localStorage` / timers: `Icon.dc.html`
  only.** No `Math.random`, no `Date.now`, no `new Date` anywhere.

Every other component in the kit is a pure function of props. That is a direct
confirmation of D13's "`ui-kit` is 100% prop-driven" — the design already is.

### React equivalent

```tsx
// DCLogic with no state and no lifecycle (54 of 56 components):
export function Thing(p: ThingProps) {
  const v = renderVals(p);      // the renderVals body, verbatim
  return <div style={v.box}>…</div>;
}

// DCLogic with state (Disclosure):
const [open, setOpen] = useState(p.open === true);

// DCLogic with lifecycle (Icon): do not port it — see §7.
```

---

## 2. `{{ expr }}` — an expression evaluator, not a key lookup

`src/expr.ts`'s `resolve(vals, src)` is a hand-written mini-parser. It is more
than a key lookup and much less than JavaScript.

**Supported**

| Form | Example | Notes |
|---|---|---|
| identifier path | `{{ item.titleStyle }}` | `.` walk, `null`-safe at every step |
| numeric member | `{{ a.0 }}` | digits accepted after `.` |
| bracket index | `{{ rows[i] }}`, `{{ m["k"] }}` | the inside is recursively `resolve`d |
| leading `!` | `{{ !open }}` | **only** as the first character |
| equality | `{{ state === 'done' }}`, `{{ a != b }}` | `==` `!=` `===` `!==`, top level only |
| parenthesised whole | `{{ (a === b) }}` | only when the parens wrap the entire expression |
| literals | `{{ true }}` `{{ false }}` `{{ null }}` `{{ undefined }}` | |
| numbers | `{{ 17 }}` `{{ -0.5 }}` | `/^-?\d+(\.\d+)?$/` |
| quoted strings | `{{ 'done' }}` `{{ "x" }}` | either quote |

**Not supported — silently yields `undefined`**: `&&`, `\|\|`, ternary,
arithmetic, function calls, optional chaining, template literals, object and
array literals, `<` `>` comparisons, `!` anywhere but position 0. This is why
every kit component front-loads all its branching into `renderVals()` and the
template only reads flat keys. Keep that discipline in the port: it is the
reason the JSX comes out trivial.

### Attribute position (`compileAttr`)

| Raw attribute value | Result |
|---|---|
| exactly `{{ expr }}` | the **resolved value**, any type — object, array, function, boolean, number |
| text containing `{{ … }}` | string concatenation; an `undefined` hole becomes `""` |
| no `{{ }}` at all | the literal **string** |

### Text position (`walkText`)

The text node is split on `{{ … }}`; literal halves render as raw strings;
expression halves render as:

| Resolved value | Rendered |
|---|---|
| `undefined` | **nothing**, plus a one-time `console.warn` per component+hole. In the DC editor (`document.body[data-dc-editor-on]`) a literal `{{ expr }}` chip instead. While streaming, a shimmer span. |
| React element, or an array | wrapped in a `<Fragment>` — **this is how `{{ children }}` works** |
| `null` or a boolean | nothing |
| anything else | `<span class="sc-interp">{String(v)}</span>` |

> **Gotcha — the interpolation span.** Every scalar text hole is wrapped in an
> extra inline `<span>`. Seven components put `{{ children }}` or `{{ label }}`
> directly inside a flex row (`Surface`, `Callout`, `ActionCard`,
> `BottomSheet`, `MessageBubble`, `PhoneFrame`, `Disclosure`). React's `{label}`
> emits a bare text node instead. An anonymous flex item and a `<span>` flex item
> behave the same for `gap` and `align-items`, but not for `flex`, `overflow`,
> `text-overflow` or `white-space`. Check those seven before assuming parity.

### `{{ children }}`

`props.children` is an array of already-rendered React nodes assembled by
`walkComponent`/`walkXImport`, injected into `vals` like any other prop and read
back out by the interpolation path above. React equivalent is exactly
`{children}` — including the array case, which React renders as a keyed list.

### The `style` attribute

| Where | Behaviour |
|---|---|
| plain DOM element, resolved value is an **object** | passed straight through as a React `style` object. This is the kit's idiom — `renderVals()` returns real React style objects, already camelCased, numbers left unitless. |
| plain DOM element, resolved value is a **string** | parsed by `cssToObj`: split on `;`, first `:` splits prop from value, kebab→camel except `--custom-props` which are kept verbatim. |
| `<dc-import>` / `<x-import>` | **NOT passed to the component.** Filtered by `hostPositionStyle` down to `position, left, right, top, bottom, inset, width, height, z-index, transform` and applied to the wrapper `<div>`. Everything else — `color`, `padding`, `flex`, `margin` — is **silently dropped**. |

React: `style={v.box}` for the object case; hand-convert the string case (only
the two `.dc.html` page-level files use inline CSS strings); for the third case,
port the intent as a real prop or a wrapper element, and never assume a `style=`
on a `<dc-import>` in the source did anything.

---

## 3. `<sc-if value="…">`

```js
let v = valGet(vals);
if (v === undefined && hintGet && ctx?.__streamingNow) v = hintGet(vals);
return v ? <Fragment>{kids}</Fragment> : null;
```

- Plain JS truthiness on the resolved value. Children render inside a Fragment.
- **There is no `sc-else` in this runtime.** `sc-else` appears only in a
  regex used for deck-slide keying; `walk()` has no branch for it, so an
  `<sc-else>` element would render as an unknown DOM tag. The kit does not use
  it. Two-way branches are resolved in `renderVals()` instead.
- `hint-placeholder-val` is consulted **only** when `value` is `undefined`
  **and** the component is mid-stream. **Editor-only. It has no effect on a
  static render.** Used by 12 components; drop it in the port.

| DC | React |
|---|---|
| `<sc-if value="{{ meta }}">…</sc-if>` | `{v.meta ? <>…</> : null}` |
| `<sc-if value="{{ !open }}">` | `{!open && <>…</>}` |

> **Gotcha — `0` and `""`.** `<sc-if value="{{ count }}">` with `count === 0`
> renders nothing. JSX's `{count && <X/>}` renders the literal `0`. Always port
> to `{cond ? <X/> : null}`, or coerce with `!!`. Same trap for `""`.

---

## 4. `<sc-for list="…" as="…">`

```js
const sub = { ...vals, [asName]: item, $index: i };
```

- `list` must resolve to an array. Anything else → `[]`, plus a one-time console
  warning (suppressed for `null`/`undefined`).
- `as` defaults to `"item"`. The item is **merged into a copy of the outer
  vals**, so outer keys stay visible inside the loop — `ScheduleList` nests two
  `sc-for`s and reads `group.*` from the inner loop.
- `$index` is injected but **no kit file uses it**.
- Children are keyed by **array index**. There is no key expression in the
  language.
- `hint-placeholder-count="N"` fills `Array(N)` with `undefined` **only while
  streaming**. **Editor-only; no effect on a static render.** Drop it.

| DC | React |
|---|---|
| `<sc-for list="{{ rows }}" as="r">…{{ r.v }}…</sc-for>` | `{v.rows.map((r, i) => <React.Fragment key={i}>…{r.v}…</React.Fragment>)}` |

Index keys are parity. Stable keys are an upgrade — take it where the list can
reorder (`QueueItemRow` lists, `TimelineList`), since nothing in the DC version
depended on index identity.

---

## 5. `<dc-import name="X" …>`

Component resolution is **by file name**: `getDC(name)` returns a memoized
dispatcher that lazily `fetch`es `./<encodeURIComponent(name)>.dc.html` from the
same directory and compiles it. In React this is an `import`.

### How props are passed

`collectProps(el, "dc-import", host)`:

- Dropped entirely: `sc-name`, `data-dc-tpl`, `hint-size`, `style`, and
  `name`/`component`.
- **kebab → camel**: any key containing `-` is camelCased, so `right-meta`
  becomes `rightMeta` and `show-home` becomes `showHome`.
- camelCase **in the source** survives HTML's attribute-lowercasing via an
  `encodeCamelAttrs` pass that rewrites `rightMeta=` to `sc-camel-right-meta=`
  on the raw string before parsing, then decodes. Both spellings therefore reach
  the component identically — the catalog uses both, sometimes on the same line.
- `dc-props="{{ obj }}"` (key `dcProps`) **spreads** the object into props.
  Unused by this kit.
- Children of the element become `props.children` as an array of rendered nodes.

### Literal parsing

| Written | Arrives as |
|---|---|
| `pulse="{{ true }}"` | boolean `true` |
| `chevron="{{ false }}"` | boolean `false` |
| `progress="{{ null }}"` | `null` |
| `tiles="{{ digestStats }}"` | the actual array from `renderVals()` |
| `size="17"` | the **string** `"17"` |
| `tone="amber"` | the string `"amber"` |

> **Gotcha — numbers arrive as strings.** `size`, `height`, `minTile`,
> `timeWidth`, `keyWidth`, `depth`, `active`, `lines` are all written bare in
> the catalog, so the component receives a string and defends with
> `Number(p.size) || 16`. In TSX these become real numbers (`size={17}`), so the
> `Number()` coercions can go — but only after checking each one, because a few
> double as the "default if absent" expression.

### `hint-size`

`hint-size="100%,124px"` is **never a prop**. Two uses, both transient:

1. the width/height of the grey `Placeholder` shown while the sibling `.dc.html`
   has not been fetched yet;
2. `minWidth`/`minHeight` on the host `<div>` while that component's HTML is
   still streaming in from the editor.

It has **zero effect on a settled render**. Delete every occurrence when
porting. It is not a layout hint to preserve; the numbers in it are eyeballed
placeholder sizes, not the component's real dimensions.

### Defaults do **not** apply to imports

`data-props` `default` values are read by `boot()`'s `StandaloneRoot` only — the
component rendered as its **own page**. `walkComponent` applies no defaults at
all. So `<dc-import name="ApprovalCard">` with zero props renders a complete card
purely from `p.x ?? …` fallbacks inside `renderVals()`.

**The porting rule** (and the README says the same): `data-props.default` maps to
a Storybook **arg**, never to a React `defaultProps` or a parameter default. The
runtime default is whatever `renderVals()` falls back to — and the kit
deliberately leaves genuinely-optional props (`meta`, `badge`, `tag`, a
`ListRow`'s `value`) with no fallback.

---

## 6. `data-props` — the prop table

JSON, HTML-entity-escaped, on the `<script data-dc-script data-props="…">` tag.
`parseDataProps` splits it into:

- `$preview: { width, height }` — the artboard size for the component's own page
  in the DC editor. Also load-bearing in one non-obvious way: when a component
  has **no** `$preview`, `boot()` injects `html,body{height:100%}` full-page CSS.
  Editor-only; ignore in the port.
- every other non-`$` key — one entry per prop.

Per-prop shape: `{ editor, default?, tsType, options?, min?, max?, step?, unit? }`.

Editor types actually present across the 56 kit files:

| `editor` | count | Means | Storybook `argTypes` |
|---|---|---|---|
| `text` | 166 | free string | `{ control: 'text' }` |
| `enum` | 60 | closed set, `options: [...]` | `{ control: 'select', options }` |
| `boolean` | 43 | checkbox | `{ control: 'boolean' }` |
| `int` | 31 | integer, `min`/`max` | `{ control: { type: 'number', min, max, step: 1 } }` |
| `float` | 8 | decimal, `min`/`max`/`step` | `{ control: { type: 'number', min, max, step } }` |
| `range` | 4 | slider, `min`/`max`, often `unit:'%'` | `{ control: { type: 'range', min, max, step } }` |
| `color` | 1 | `Icon.color`, with an `options` swatch list | `{ control: 'color' }` + `presetColors` |
| `null` | 56 | **not editable**: object arrays, `ReactNode`, `() => void` | `{ control: false }`, or `{ action: 'onClick' }` for callbacks |

`tsType` is already TypeScript source text — `"ReactNode"`, `"() => void"`,
`"{label:string; icon?:IconName; tone?:Tone}[]"`. Copy it into the props
interface rather than re-deriving it. `unit` is an editor display suffix only.

Callback props declared today: `onClick` (11 components), `onAction`, `onStop`,
`onUndo`, `onUp`, `onDown`, plus `onClick` inside several item-array `tsType`s.
They are declared and threaded to `onClick="{{ onClick }}"` on the root element
(the runtime maps `onClick` → React `onClick` via `EVENT_MAP` / the `on` +
uppercase fallback), but the catalog never passes one. **They are a wired seam
with no call sites** — the port should keep them and add the missing hover/focus
affordances, which do not exist anywhere in the kit.

---

## 7. Construct → React, the short table

| DC construct | React / JSX | Gotchas |
|---|---|---|
| `class Component extends DCLogic` | function component | `renderVals()` body → function body; it is a pure function of props in 55 of 56 files |
| `renderVals()` | computed locals | runs every render, unmemoized; its keys **shadow** props of the same name |
| `this.props` | `p` | internal `__name`/`__hintSize`/`__tplId`/`__hostStyle` are stripped before the logic sees them |
| `this.state` + `setState` | `useState` | only `Disclosure` |
| `componentDidMount` etc. | `useEffect` | only `Icon`, and it should not be ported (see below) |
| `{{ path.to.value }}` | `{v.path.to.value}` | scalar holes gain a `<span class="sc-interp">` in DC, not in React |
| `{{ children }}` | `{children}` | DC passes an array of nodes |
| `style="{{ obj }}"` | `style={v.obj}` | already React style objects |
| `style="color:red"` (literal) | `style={{ color: 'red' }}` | `cssToObj` parses at compile time |
| `style=` on `<dc-import>` | a wrapper `<div style>` | only position/size survive in DC; everything else was already dead |
| `<sc-if value="{{ x }}">` | `{x ? <>…</> : null}` | never `{x && …}` — `0` and `""` |
| `hint-placeholder-val` | — | editor/streaming only; delete |
| `<sc-for list="{{ xs }}" as="x">` | `{v.xs.map((x, i) => <Fragment key={i}>…)}` | index keys; `$index` unused; outer scope stays visible |
| `hint-placeholder-count` | — | editor/streaming only; delete |
| `<dc-import name="X" a="1" b="{{ o }}">` | `<X a="1" b={v.o} />` | kebab→camel; bare attrs are strings |
| `hint-size="W,H"` | — | never a prop; delete |
| `<helmet>` | global CSS / `<head>` | see below |
| `data-props` | props interface + `argTypes` | `default` → story arg, **not** a React default |
| `$preview` | — | editor artboard; ignore |

---

## 8. Things the DC runtime does that React does not — the real risks

1. **Every component is wrapped in an extra `<div class="sc-host">.**
   `StreamableComponent.render()` returns
   `<div class="sc-host" data-sc-name="X" data-dc-tpl="…" style={hostStyle}>…</div>`.
   It is a plain block div — nothing in `BASE_CSS` gives it `display:contents`.
   So in the DC rendering, a `<dc-import>` inside a flex column is a *div* flex
   item whose child is the component root (usually `width:100%`,
   `boxSizing:border-box`). Dropping the wrapper in React changes which element
   is the flex item, which `flex`/`min-height:0`/`gap` apply to. **Port the
   §11 assembled screens first and compare against the DC render**, because that
   is where nesting is deepest (`PhoneFrame > Surface > ListRow`).

2. **`<helmet>` injects into the live document `<head>` at render time.** Each
   component's helmet carries its own Google Fonts `<link>` and a `<style>` with
   `@keyframes breathe` — which is therefore declared in **13 separate component
   files**. Only `<script>`, `<link>` and `<meta>` are content-deduped; `<style>`
   is keyed by component name and mounted per component, so all thirteen copies
   land in `<head>`. All 56 components also set `body{margin:0;background:#0c0e12}`
   there, so rendering one component repaints the page. In React this becomes one
   global stylesheet (one `@keyframes breathe`, one font load, one body rule, none
   of it owned by a component). This matches the
   already-noted constraint that Storybook has no shell and must load DM Serif
   Text / Plus Jakarta Sans / JetBrains Mono itself.

3. **`Icon` mutates the DOM outside React.** Its template emits
   `<i data-lucide="{{ glyph }}">` and its lifecycle calls
   `window.lucide.createIcons()` on mount, on a 300 ms timer, and on every
   update — Lucide **replaces** the `<i>` with an `<svg>`, behind React's back.
   The Lucide UMD script arrives via `Icon`'s own `<helmet>`, which is why the
   catalog page works without loading Lucide itself. **Do not port this.** Use
   `lucide-react` components and keep `Icon.tsx` as the single semantic-key →
   glyph map (75 keys today), exactly as the README's swap instructions intend.
   This is the one place where DC behaviour is not reproducible from props, and
   the React version is strictly better.

4. **`Disclosure` is uncontrolled after first interaction.**
   `const open = this.state.open === null ? p.open === true : this.state.open` —
   once toggled, the `open` prop is permanently ignored. `useState(p.open === true)`
   reproduces this exactly. Decide deliberately whether the React version should
   instead be controllable (`open` + `onOpenChange`); a Storybook story that
   flips the `open` arg will otherwise appear broken, and that is the DC
   behaviour, not a port bug.

5. **`undefined` holes warn in DC and are silent in React.** `walkText` logs
   `"{{ x }} never resolved — rendered as empty"` once per component+hole, and
   `sc-for` logs when its list is not an array. React renders nothing and says
   nothing. That dev signal is worth re-creating — required props in TS plus a
   dev-mode assert covers most of it.

6. **Hot-swap, streaming, and the registry do not port and must not be
   emulated.** `registry.bump`, `subs`, `__reconcileLogic`, `jsStreaming`/
   `htmlStreaming`, `setStreaming`, `dcUpdate`, `__dcSetProps`, the postMessage
   bridge to the editor, `sc-shine`, and the placeholder system exist for the DC
   authoring editor. Nothing downstream of them belongs in `ui-kit`.

7. **A name collision to be aware of.** The runtime has its own internal
   `Placeholder` React component (the grey box for an unresolved import) and the
   kit has a `Placeholder.dc.html` (the loading/empty/error primitive). They are
   unrelated. Only the kit one is being ported.

8. **The catalog's own `style-*` pseudo-class mechanism is unused.** The runtime
   supports `style-hover="…"` / `style-before="…"` attributes that compile to
   generated `.scp<N>:hover` rules with `!important`. **Zero kit files use it.**
   Combined with the README's "no focus/hover states yet", every interaction
   state in `ui-kit` is net-new design work, not a port.

9. **`x-import` is unused.** No kit file loads an external module, so the whole
   external-module / Babel / global-polling path is dead weight for this port.
   Good news: there are no third-party React dependencies hiding in the design.
