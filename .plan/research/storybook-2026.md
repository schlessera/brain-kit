# Storybook for a Bun + React 19 + Tailwind v4 monorepo — research, 2026-09-15

Every version below was read from the npm registry (`npm view`) on 2026-09-15.
Every config file below was **executed**, not copied from docs: a throwaway Bun
workspace at `/tmp/claude-1000/sbtest` (two packages, `@sbtest/ui` +
`@sbtest/storybook`) was built and tested end to end under the Bun runtime. Where
the official docs disagree with what the tooling actually does, the observed
behaviour is called out explicitly.

---

## 1. Current versions and package layout

### Versions (npm, 2026-09-15)

| Package | Latest | Notes |
| --- | --- | --- |
| `storybook` | **10.6.0** | core CLI + runtime. `11.0.0-alpha.0` exists on npm; 11 lands "next Spring" |
| `@storybook/react-vite` | **10.6.0** | framework package |
| `@storybook/addon-docs` | **10.6.0** | absorbed `@storybook/blocks` in 9.0 |
| `@storybook/addon-a11y` | **10.6.0** | |
| `@storybook/addon-vitest` | **10.6.0** | the test addon (renamed from `@storybook/experimental-addon-test` in 9.0) |
| `@storybook/addon-themes` | **10.6.0** | still first-party, still maintained |
| `@storybook/addon-links` | **10.6.0** | |
| `@storybook/addon-mcp` | **10.6.0** | new; MCP server for agents (preview) |
| `@storybook/test-runner` | **0.24.5** | superseded, separate versioning |
| `@chromatic-com/storybook` | **5.3.1** | visual tests addon (cloud, paid tiers) |
| `eslint-plugin-storybook` | **10.6.0** | |
| `@storybook/addon-coverage` | **3.0.2** | only needed for the test-runner path |

Dead packages — **do not install**, their last versions are 8.x/9.x:
`@storybook/addon-essentials` (8.6.14), `@storybook/addon-interactions` (8.6.14),
`@storybook/test` (8.6.15), `@storybook/experimental-addon-test` (8.6.14),
`@storybook/addon-controls` (9.0.8), `@storybook/addon-viewport` (9.0.8),
`@storybook/blocks`, `@storybook/addon-backgrounds`, `@storybook/addon-measure`,
`@storybook/addon-outline`, `@storybook/addon-toolbars`, `@storybook/storysource`,
`@storybook/addon-mdx-gfm`.

### The 8 → 9 consolidation, and what 10 changed

Storybook 9 folded most addons into the `storybook` package. From
`MIGRATION.md` (v10.6.0 tag), "Dropped support for legacy packages":

| Old package | New import path |
| --- | --- |
| `@storybook/manager-api` | `storybook/manager-api` |
| `@storybook/preview-api` | `storybook/preview-api` |
| `@storybook/theming` | `storybook/theming` |
| `@storybook/test` | `storybook/test` |
| `@storybook/addon-actions` | `storybook/actions` |
| `@storybook/addon-highlight` | `storybook/highlight` |
| `@storybook/addon-viewport` | `storybook/viewport` |
| `@storybook/addon-backgrounds` | built in (no import path) |
| `@storybook/addon-controls` | built in |
| `@storybook/addon-interactions` | built in |
| `@storybook/addon-measure` | built in |
| `@storybook/addon-outline` | built in |
| `@storybook/addon-toolbars` | built in |

So today a React+Vite Storybook needs exactly: `storybook`,
`@storybook/react-vite`, and whichever of `addon-docs` / `addon-a11y` /
`addon-vitest` / `addon-themes` / `addon-links` / `addon-mcp` you want.
Controls, viewport, backgrounds, actions, interactions, measure and outline are
core — you neither install nor register them.

**Storybook 10 (breaking) changes:**
- ESM-only distribution. Install size down 29% on top of 9's 50%. `dist` ships
  unminified. https://storybook.js.org/blog/storybook-10/
- `.storybook/main.*` and every preset **must be valid ESM**.
- **Node 20.19+ or 22.12+** required (the blog says 20.16+/22.19+/24+; MIGRATION.md
  says 20.19+/22.12+ — take the stricter: Node 22.12+ or 24).
- `tsconfig.json` `moduleResolution` must support the `types` condition
  (`bundler`, `node16`, `nodenext` — not `node`).
- `core.builder` and local addons must be fully resolved paths.
- Vite floor is **5.0** (Vite 4 dropped in 9.0); `@storybook/react-vite` peers
  `vite: ^5 || ^6 || ^7 || ^8`.
- `sb.mock` module mocking (Vite + Webpack, dev + static builds).
- Vitest 4 and Next 16 support.

**10.6 specifically** (`MIGRATION.md` § "From version 10.5.x to 10.6.0"):
- `@storybook/csf-plugin` removed.
- Experimental Playwright CT integration removed.
- Vue 3 `vue-docgen-api` deprecated (irrelevant to us).
- MCP tool names moved to `toolset.method` → `toolset-method` form
  (`stories.preview` → `stories-preview`).

`storybook`'s peer deps are `prettier` (optional), `@types/react` (optional), and
`vite-plus` (optional) — `vite-plus` is VoidZero's unified toolchain, currently
0.3.2, an opt-in path we do not need.

---

## 2. Testing: `@storybook/addon-vitest` is the answer, test-runner is superseded

### Is `@storybook/test-runner` deprecated?

Effectively yes. The docs page carries a notice at the top:

> "The test runner has been superseded by the Vitest addon, which offers the same
> functionality, powered by the faster and more modern Vitest browser mode."
> … "If you are using a Vite-powered Storybook framework, we recommend using the
> Vitest addon instead of the test runner."

— https://storybook.js.org/docs/writing-tests/integrations/test-runner

It is still published (0.24.5) and documented as the Webpack-builder escape
hatch. We use Vite, so it is irrelevant to us. The only capability it has that
the Vitest addon does not is DOM snapshot testing (see the comparison table in
`docs/writing-tests/integrations/vitest-addon/index.mdx`) — and portable stories
cover that anyway.

### The supported stack

`@storybook/addon-vitest@10.6.0` peer dependencies (verbatim from npm):

```json
{
  "vitest": "^3.0.0 || ^4.0.0",
  "storybook": "^10.6.0",
  "@vitest/runner": "^3.0.0 || ^4.0.0",
  "@vitest/browser": "^3.0.0 || ^4.0.0",
  "@vitest/browser-playwright": "^4.0.0"
}
```

**⚠️ Vitest `latest` on npm is 5.0.1 — outside that range.** Pin Vitest 4:
`vitest@4.1.11`, `@vitest/browser@4.1.11`, `@vitest/browser-playwright@4.1.11`,
`@vitest/coverage-v8@4.1.11`, `playwright@1.63.0`.

This is not theoretical: `bunx storybook@latest init` writes `"vitest": "latest"`
into `package.json`, which resolved to 5.0.1 in my test. Under Vitest 5 the
interaction tests still ran, but `toMatchScreenshot` broke (the attachments
directory moved from `.vitest-attachments/` to `.vitest/attachments/`) and
nothing in the peer range covers it. Pin 4.

### How it works

The addon's Vite plugin transforms every story into a Vitest test using the
portable-stories API, and runs them in **Vitest browser mode driven by
Playwright Chromium** — a real browser, not happy-dom/jsdom. Each story gets a
smoke test (does it render) plus its `play` function if present.

Consequence for this repo: the Storybook test project is a **separate Vitest
project** and does not interfere with `bun test` + happy-dom. They coexist; run
them as two commands.

### Config files (verified working)

`vite.config.ts` — the Storybook Vite builder auto-loads the project's
`vite.config.ts` and merges it, so Tailwind and the React plugin go here once:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
```

`vitest.config.ts` — matches the official Vitest-4 snippet
(`docs/_snippets/vitest-plugin-vitest-config.md`, `renderer="react" tabTitle="Vitest 4"`):

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          plugins: [
            storybookTest({
              configDir: path.join(dirname, '.storybook'),
              storybookScript: 'bun run storybook --no-open',
              storybookUrl: process.env.SB_URL, // CI: link failures to the published SB
            }),
          ],
          test: {
            name: 'storybook',
            browser: {
              enabled: true,
              provider: playwright({}),
              headless: true,
              instances: [{ browser: 'chromium' }],
            },
          },
        },
      ],
    },
  }),
);
```

Note the `provider` shape differs by Vitest major: Vitest 4 wants
`provider: playwright({})` imported from `@vitest/browser-playwright`; Vitest 3
wanted the string `provider: 'playwright'`. Use the Vitest 4 form.

`vitest.shims.d.ts` (generated by init, needed for browser-mode types):

```ts
/// <reference types="@vitest/browser-playwright" />
```

**`.storybook/vitest.setup.ts` is no longer needed.** The docs snippets still
show a `setupFiles: ['./.storybook/vitest.setup.ts']` entry containing
`setProjectAnnotations`, but running it produces this warning, verbatim from my
test run:

```
Info: Found a setup file with "setProjectAnnotations".
Skipping automatic provisioning of preview annotations to avoid conflicts.
Since Storybook 10.3, "@storybook/addon-vitest" applies these automatically.
You can safely remove the "setProjectAnnotations" call from your setup file,
or remove the file entirely if you don't have custom code there.
```

I removed the file and both tests still passed. The `storybook init` scaffold
(10.6.0) also emits **no** `setupFiles` entry, confirming this. Omit it unless
you have genuine custom setup code.

`package.json` scripts:

```json
{
  "scripts": {
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build",
    "test-storybook": "vitest --project=storybook",
    "test-storybook:ci": "vitest run --project=storybook"
  }
}
```

### Interaction tests

Canonical modern signature destructures `canvas` and `userEvent` **from the play
context** (`docs/_snippets/login-form-with-play-function.md`). The
`within(canvasElement)` style in the `storybook init` sample stories is the old
form and should not be copied:

```ts
export const FilledForm = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.type(canvas.getByTestId('email'), 'email@provider.com');
    await userEvent.click(canvas.getByRole('button'));
    await expect(args.onSubmit).toHaveBeenCalled();
  },
});
```

`expect`, `fn`, `userEvent`, `within`, `waitFor`, `spyOn` all come from
`storybook/test` (not `@storybook/test`, which is dead at 8.6.15).

### Accessibility tests — verified failing correctly

Install `@storybook/addon-a11y`, register it, and set the behaviour parameter.
`parameters.a11y.test` takes three values
(`docs/writing-tests/accessibility-testing.mdx`):

| Value | Behaviour |
| --- | --- |
| `'off'` | no automated checks |
| `'todo'` | violations warn in the Storybook UI; **silent in CI** |
| `'error'` | violations fail the test in UI and CLI/CI |

The docs are explicit: *"Accessibility tests will only produce errors in CI if
you have set `parameters.a11y.test` to `'error'`."* `storybook init` scaffolds
`'todo'`, which means a11y failures are invisible in CI by default. Set
`'error'` in `.storybook/preview.ts` project-wide, and downgrade to `'todo'` per
story where you have a known debt.

Verified: with `a11y: { test: 'error' }` in the preview, a story rendering
`<img src="x.png" />` failed with

```
expect(received).toHaveNoViolations(expected)
Expected the HTML found at $('img') to have no violations:
Received: "Images must have alternative text (image-alt)"
```

axe-core 4.13 under the hood. Storybook disables the `region` rule by default
(false positives on isolated components). Change rulesets with
`parameters.a11y.options.runOnly`, individual rules with `parameters.a11y.config.rules`.

### Visual regression without paying for Chromatic — verified working

Storybook's own `docs/writing-tests/visual-testing.mdx` only documents Chromatic
(`@chromatic-com/storybook@5.3.1`), the paid cloud service by the Storybook team.
There is no first-party free visual-regression path.

**But** Vitest 4 browser mode ships `toMatchScreenshot`, and because the addon
runs stories *inside* Vitest browser mode, you can assert screenshots from a
story's `play` function. I verified this end to end:

```ts
export const Snapshot = meta.story({
  play: async ({ canvasElement }) => {
    const { expect } = await import('vitest');
    await expect(canvasElement).toMatchScreenshot('button-default');
  },
});
```

Run 1 writes the baseline and fails (standard new-baseline behaviour):
`src/__screenshots__/Visual.stories.ts/button-default-chromium-linux.png`.
Run 2 compares and passes.

Config (`vitest.config.ts`, inside `test.browser`):

```ts
expect: {
  toMatchScreenshot: {
    comparatorName: 'pixelmatch',
    comparatorOptions: { threshold: 0.2, allowedMismatchedPixelRatio: 0.01 },
  },
},
```

https://vitest.dev/guide/browser/visual-regression-testing

**The catch, and it's the deciding one:** baselines are named
`<name>-<browser>-<platform>.png`. Vitest's own guidance is that rendering "is
not perfectly deterministic across environments" (GPU, OS, fonts, browser
version) and that visual tests "are most reliable when run in a standardized and
tightly controlled environment", with Docker "strongly recommended". A baseline
generated on a dev machine will not match CI. So this only works if **both** CI
and local baseline generation happen inside the same
`mcr.microsoft.com/playwright:v1.63.0-noble` container. That is a real cost;
budget for it or skip visual regression initially and rely on interaction + a11y
+ manual review.

### Coverage

`vitest run --project=storybook --coverage` with `@vitest/coverage-v8@4.1.11`.
`@storybook/addon-coverage` is only for the test-runner path — do not install it.

### Theme coverage: run every story twice

The addon's `initialGlobals` plugin option pins a global per Vitest project, so
you can run the entire story set under light and dark
(`docs/writing-tests/integrations/vitest-addon/index.mdx`, `initialGlobals`):

```ts
const storybookProject = (theme: string) => ({
  extends: true,
  plugins: [
    storybookTest({
      configDir: path.join(dirname, '.storybook'),
      initialGlobals: { theme },
    }),
  ],
  test: {
    name: `storybook-${theme}`,
    browser: { enabled: true, provider: playwright({}), headless: true,
               instances: [{ browser: 'chromium' }] },
  },
});

export default mergeConfig(viteConfig, defineConfig({
  test: { projects: [storybookProject('light'), storybookProject('dark')] },
}));
```

This is the single highest-value thing for a chat UI kit — contrast bugs in dark
mode get caught by axe automatically, in both themes, with no extra stories.

### Selecting which stories are tested

By default every story with the `test` tag runs. Narrow it with the plugin's
`tags` option (`include` / `exclude` / `skip`); `exclude` wins over `include`.
Per story, `tags: ['!test']` opts out entirely, `tags: ['!autodocs']` keeps it
out of docs.

---

## 3. Bun compatibility — verified, works

Bun is a **first-class package manager** in Storybook 10.6. `JsPackageManagerFactory.ts`
(v10.6.0) has a `BUNProxy`, detects both `bun.lock` and `bun.lockb`, and resolves
lockfiles with `find.up(..., { last: root })` — which is precisely the fix for
issue [#31832](https://github.com/storybookjs/storybook/issues/31832) ("v9.0.12
broken for bun monorepos", the lockfile-only-at-repo-root case). That issue is
closed, as are [#30654](https://github.com/storybookjs/storybook/issues/30654)
("can not build stories with Bun", closed 2026-02-23) and
[#25389](https://github.com/storybookjs/storybook/issues/25389) ("Cannot use Bun
with storybook init", closed 2025-11-19). The only Bun issue still open is
[#28970](https://github.com/storybookjs/storybook/issues/28970), a PostCSS
`EISDIR` from 8.2.0 in May 2025 — PostCSS, which we don't use with Tailwind v4's
Vite plugin.

### What I ran, on Bun 1.3.14, in a two-package Bun workspace

| Command | Result |
| --- | --- |
| `bun install` (root workspace, 456 packages) | ✅ 4.4s |
| `bunx storybook build` (Bun runtime) | ✅ built in 3.21s |
| `bunx storybook dev -p 6099 --ci` | ✅ "Storybook ready", 66ms manager / 124ms preview; `/index.json` served correct entries |
| `bunx vitest run --project=storybook` (Vitest 4 browser mode + Playwright Chromium) | ✅ 3 tests passed |
| `bunx playwright install chromium` | ✅ (without `--with-deps`, which needs sudo) |
| `bunx storybook@latest init --yes --package-manager bun` in a clean Bun+Vite+React 19 project | ✅ exit 0 |

The sibling workspace package (`@sbtest/ui`, `workspace:*`, source-only
`exports` with a `bun` condition) resolved and bundled without any Vite alias or
`optimizeDeps` tweaking. No `optimizeDeps` problems appeared at all.

### Bun gotchas worth knowing

1. **`storybook init` writes `"vitest": "latest"`** → Vitest 5, outside the
   addon's peer range. Bun does not enforce peers, so it installs silently.
   Pin Vitest 4 by hand afterwards. (Same trap with
   `@vitest/browser-playwright`, `@vitest/coverage-v8`, `playwright`, and
   `@chromatic-com/storybook`, all written as `latest`.)
2. **`bunx playwright install chromium --with-deps` needs sudo** and fails
   non-interactively. Use `--with-deps` only in the CI container (or use the
   prebuilt Playwright image, which already has both).
3. `storybook init` failed to resolve `@storybook/addon-mcp`'s postinstall hook
   under Bun and told me to run `bunx storybook add @storybook/addon-mcp`
   manually. Cosmetic, but it means the MCP wiring needs a manual step.
4. `storybook init` leaves a `debug-storybook.log` in the project root —
   gitignore it.
5. Storybook's change-detection feature logs
   `Change detection unavailable: not a git repository` outside a repo. Harmless.

### One thing I did not test

`bun test` (Bun's own runner) does not enter the picture: the Storybook tests run
through `vitest`, which runs fine under `bunx`. There is no attempt anywhere to
make Storybook stories run under `bun test` + happy-dom, and I would not try —
the whole value of the Vitest addon is the real browser.

---

## 4. Tailwind v4 + Storybook

### Use `@tailwindcss/vite`, not PostCSS

Tailwind is **4.3.3**. The official Storybook Tailwind recipe
(https://storybook.js.org/recipes/tailwindcss) is stale — it still talks about
`tailwind.config.js` `darkMode` and `@storybook/addon-styling-webpack`. Ignore
the v3 parts.

The correct v4 + Vite setup is: put `@tailwindcss/vite` in the project's
`vite.config.ts`. Storybook's Vite builder **auto-loads and merges the project's
`vite.config.ts`** (`docs/builders/vite.mdx`: *"When Storybook loads, it
automatically merges the configuration into its own"*), so no `viteFinal` is
needed. Verified: Tailwind utilities and preflight landed in the built
`storybook-static/assets/iframe-*.css`.

Then import the CSS from `.storybook/preview.ts`.

### 🔴 The monorepo gotcha — Tailwind v4 will silently not see sibling packages

Tailwind v4 has no `content` array; it auto-detects sources relative to the CSS
file, stopping at the package/git boundary and skipping `node_modules` and
`.gitignore`d paths. **Components living in a sibling workspace package are
outside that root and produce no utilities.**

I hit this exactly. First build: `bg-blue-600` appeared **zero** times in the
output CSS even though the component used it — preflight was there, utilities
were not. Adding one line fixed it:

```css
@import "tailwindcss";
@source "../../ui/src";                                   /* ← sibling workspace package */
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
```

After: `bg-blue-600` present, and the dark variant compiled to
`.dark\:bg-blue-400:where([data-theme=dark],[data-theme=dark] *)`.

This is the single most likely thing to waste an afternoon. Whoever sets this up
must verify utilities are in the built CSS, not just that the build succeeded.

### Dark mode in v4

`darkMode: 'class'` is gone. Use `@custom-variant` in CSS
(https://tailwindcss.com/docs/dark-mode):

```css
/* class-based */
@custom-variant dark (&:where(.dark, .dark *));
/* or attribute-based (pairs with withThemeByDataAttribute) */
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
```

### Theme toggle: `@storybook/addon-themes` is alive and first-party

`@storybook/addon-themes@10.6.0`, in-tree at `code/addons/themes`. Three
decorators (`code/addons/themes/docs/api.md`):

| Decorator | Use for |
| --- | --- |
| `withThemeByClassName({ themes, defaultTheme, parentSelector? })` | class-based (Tailwind `.dark`) |
| `withThemeByDataAttribute({ themes, defaultTheme, attributeName?, parentSelector? })` | attribute-based; `attributeName` defaults to `data-theme`, `parentSelector` to `"html"` |
| `withThemeFromJSXProvider({ themes, defaultTheme, Provider, GlobalStyles })` | context providers (Emotion, MUI, styled-components) |

Per-story override is `globals: { theme: 'dark' }` on a story or meta.
Custom decorators can read the toolbar state via
`DecoratorHelpers.pluckThemeFromContext` + `initializeThemeState`.
`DecoratorHelpers.useThemeParameters` is deprecated.

Verified working in `.storybook/preview.ts`:

```ts
import { definePreview } from '@storybook/react-vite';
import addonA11y from '@storybook/addon-a11y';
import addonThemes, { withThemeByDataAttribute } from '@storybook/addon-themes';
import '../src/tailwind.css';

export default definePreview({
  addons: [addonA11y(), addonThemes()],
  decorators: [
    withThemeByDataAttribute({
      themes: { light: 'light', dark: 'dark' },
      defaultTheme: 'light',
      attributeName: 'data-theme',
    }),
  ],
  parameters: { a11y: { test: 'error' } },
  tags: ['autodocs'],
});
```

Pair the `theme` global with the per-project `initialGlobals` trick from §2 to
test both themes automatically.

---

## 5. React 19

Fully supported, no caveats found.

`@storybook/react-vite@10.6.0` peers: `react: ^16.8 || ^17 || ^18 || ^19`,
`react-dom` the same, `vite: ^5 || ^6 || ^7 || ^8`, `typescript: >= 4.9`.
React latest is **19.3.0**. My test project ran React 19.3.0 throughout — build,
dev server, and browser-mode tests — with zero React-related warnings.

Scanning open React-19-tagged issues in the Storybook repo turns up only
`@storybook/nextjs-vite` RSC and `next/image` problems
([#36257](https://github.com/storybookjs/storybook/issues/36257),
[#35871](https://github.com/storybookjs/storybook/issues/35871)) — Next-specific,
not `react-vite`. There is an open PR "React: Raise the supported floor to 18"
([#36169](https://github.com/storybookjs/storybook/pull/36169)), i.e. the trend is
to drop *old* React, not to restrict 19.

One thing to know: for `react-vite`, automatic argType inference defaults to
`react-docgen` (fast) rather than `react-docgen-typescript`. If prop tables come
out thin for complex generic/intersection prop types, switch via
`typescript: { reactDocgen: 'react-docgen-typescript' }` in `.storybook/main.ts`
— at a build-speed cost.

Storybook's own manager UI bundles its own React 18 internally
(`assets/react-18-*.js` in the build output). That is isolated from the preview
iframe and is not a conflict.

---

## 6. Story format: CSF 3 is stable, CSF Next ("CSF 4"/factories) is Preview

Storybook 10 promoted CSF Factories — now branded **CSF Next** — from
Experimental to **Preview**. The docs page
(`docs/api/csf/csf-next.mdx`, v10.6.0) carries this banner:

> "This is a **preview** feature and (though unlikely) the API may change in
> future releases."

and the 10 blog post says *"we don't anticipate any significant changes when we
make Factories the default in Storybook 11 next Spring."*
React, Vue, Angular and Web Components are supported; `storybook init` still
scaffolds CSF 3.

### Recommendation

**Write CSF Next.** It is Preview, not Experimental; it is the default in the
next major (Spring 2026, i.e. months away); a codemod exists in both directions;
and mixing formats across files is allowed (only *within* one file it is not).
Starting a brand-new component library on the format that becomes default in the
next major, rather than on the one that will need a codemod, is the right call.
I verified CSF Next works end to end under Bun: `defineMain`, `definePreview`,
`preview.meta`, `meta.story`, play functions, autodocs, a11y, the Vitest addon.

If the team wants zero preview-API exposure, CSF 3 with
`satisfies Meta<typeof X>` remains fully supported "for the foreseeable future"
and is what `storybook init` produces.

### CSF Next — canonical example (this exact code ran and passed)

`.storybook/main.ts`:

```ts
import { defineMain } from '@storybook/react-vite/node';

export default defineMain({
  framework: '@storybook/react-vite',
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],
  addons: [
    '@storybook/addon-docs',
    '@storybook/addon-a11y',
    '@storybook/addon-themes',
    '@storybook/addon-vitest',
  ],
});
```

`.storybook/preview.ts` — see §4 above. Note addons are registered **twice**, by
string in `main.ts` (loads the addon) and as factories in `definePreview`'s
`addons` array (which is what makes `parameters.a11y` type-safe).

`src/Button.stories.ts`:

```ts
import { Button } from '@sbtest/ui';
import { expect, fn } from 'storybook/test';
import preview from '../.storybook/preview';

const meta = preview.meta({
  component: Button,
  args: { label: 'Click me', onClick: fn() },
  parameters: { layout: 'centered' },
});

export const Default = meta.story({});

export const Clicked = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByRole('button'));
    await expect(args.onClick).toHaveBeenCalled();
  },
});
```

No `Meta`/`StoryObj` imports, no `satisfies`, no `export default meta` — types
flow from `definePreview` → `preview.meta` → `meta.story`.

Extras:
- `Story.extend({...})` composes a story from another. Merge rules: args shallow
  merged, parameters deep merged (arrays replaced), decorators and tags
  concatenated. This is excellent for a chat kit — `Message` → `MessageStreaming`
  → `MessageStreamingWithTools` as a chain of `.extend`.
- `preview.type<{ args: CustomProps }>().meta({...})` when you need to widen the
  inferred prop type (e.g. a render-prop wrapper).
- `Story.test('name', async ({ canvas, userEvent, args }) => {...})` attaches a
  named test to a story. **Still Experimental**, gated behind
  `features: { experimentalTestSyntax: true }`. Don't use it yet.
- Use subpath imports so story files don't carry `../../../.storybook/preview`:
  add `"imports": { "#*": ["./*", "./*.ts", "./*.tsx"] }` to `package.json`, then
  `import preview from '#.storybook/preview'`.

Migration codemod: `storybook automigrate csf-factories` (with `-c <dir>` per
config directory in a monorepo).

### CSF 3 reference (if you go that way)

```ts
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Button } from './Button';

const meta = {
  component: Button,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: { onClick: fn() },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { primary: true, label: 'Button' } };
```

`satisfies Meta<typeof Button>` + `StoryObj<typeof meta>` is still exactly how
typing works: `satisfies` keeps the literal type of `meta` so `StoryObj<typeof meta>`
knows which args are already supplied at the meta level and makes them optional
per story. Note `Meta`/`StoryObj` come from `@storybook/react-vite` (the framework
package), not `@storybook/react`.

---

## 7. Autodocs and MDX

Both fully supported; nothing has been deprecated.

**Autodocs** is tag-driven. A docs page is generated for any CSF file with at
least one story tagged `autodocs`. Enable project-wide in `.storybook/preview.*`
with `tags: ['autodocs']`; opt a component out with `tags: ['!autodocs']` on the
meta, or a single story with the same tag on the story.
`main.ts` `docs` options: `defaultName` (default `'Docs'`) and `docsMode`
(sidebar shows docs entries only). The old `docs.autodocs` main.js key was
deprecated back in 8.1 — do not use it.

**MDX** is alive (`docs/writing-docs/mdx.mdx`). Two uses:
1. Standalone documentation pages (`Intro.mdx`, design-token references,
   "how to compose a chat view") that sit in the sidebar alongside stories.
2. Hand-authored component docs that reference CSF stories via
   `<Meta of={...} />` + `<Story of={...} />` + doc blocks, replacing the
   autodocs page for that component.

Custom autodocs templates: set `parameters.docs.page` to a React component
composed of doc blocks (`Title`, `Subtitle`, `Description`, `Primary`,
`Controls`, `Stories`), or write an MDX template and mark it with
`<Meta isTemplate />`.

Note `@storybook/blocks` no longer exists — doc blocks come from
`@storybook/addon-docs`. `@storybook/addon-mdx-gfm` was removed in 9.0.

For a chat UI kit the practical split is: autodocs everywhere for free API
tables, plus a handful of MDX pages for the composition story (message list +
composer + streaming states), which autodocs cannot express.

---

## 8. Monorepo layout

**There is no official Storybook monorepo guide.** I searched the v10.6.0 docs
tree: `monorepo` appears only incidentally (Angular CLI, telemetry, typescript,
autodocs). The [RFC for first-class monorepo support](https://github.com/storybookjs/storybook/discussions/22521)
and [the docs request](https://github.com/storybookjs/storybook/issues/22271)
are both still open. So the recommendation below is from what I verified, not
from doctrine.

### Recommended: one dedicated Storybook workspace package

```
packages/
  chat-ui/                    # the component library
    src/
      Message.tsx
      Message.stories.ts      # stories live NEXT TO components
    package.json              # exports src/ under the `bun` condition
  storybook/                  # the Storybook app
    .storybook/
      main.ts
      preview.ts
    src/
      tailwind.css
      docs/Intro.mdx
    vite.config.ts
    vitest.config.ts
    package.json              # depends on chat-ui via workspace:*
```

with `main.ts` globbing across the workspace boundary:

```ts
stories: [
  '../src/**/*.mdx',
  '../../chat-ui/src/**/*.stories.@(ts|tsx)',
],
```

Why this shape:
- **Stories next to components.** They are the component's tests and its usage
  documentation; separating them rots them. This is also what the Vitest addon
  assumes.
- **Storybook's own deps stay out of the shipped library package.** `chat-ui`'s
  `package.json` gains nothing; `@storybook/*` and Playwright live only in the
  Storybook workspace and never reach consumers.
- **The `.storybook` directory exists once.** Adding a second component package
  later means one more glob line, not a second Storybook install.
- The counter-argument from the field (["one storybook per app is cleaner"](https://github.com/vercel/turborepo/discussions/6879))
  applies when packages use *different frameworks or build setups* — an app with
  Next and a library with Vite. That is not our case: one framework, one Vite
  config.

Verified in my test: a sibling `workspace:*` package with source-only `exports`
resolved cleanly for build, dev and browser-mode tests, with no aliasing.

Two things the layout forces you to remember:
1. `@source "../../chat-ui/src";` in the Tailwind entry CSS (§4).
2. Run `bun install` from the workspace root, never from `packages/storybook` —
   the lockfile lives at the root and Storybook's `find.up` is fine with that.

If you ever do need several Storybooks, [Storybook Composition](https://storybook.js.org/docs/sharing/storybook-composition)
federates them into one sidebar via `refs` in `main.ts`. Not needed now.

---

## 9. CI (GitHub Actions)

The official pattern (`docs/writing-tests/in-ci.mdx`) is to run the job **inside
the Playwright container image** so the browser and its system libs are already
there. Adapted for Bun and this repo's layout; the image tag must match the
installed `playwright` version (**1.63.0** today):

```yaml
name: Storybook

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    container:
      # Must match the `playwright` version in package.json.
      image: mcr.microsoft.com/playwright:v1.63.0-noble
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build Storybook
        run: bun run --filter '@brain/storybook' build-storybook

      - name: Run Storybook tests (interaction + a11y)
        run: bun run --filter '@brain/storybook' test-storybook:ci
        env:
          SB_URL: ${{ env.STORYBOOK_URL }}   # optional; links failures to a published SB
```

Notes:
- `vitest run --project=storybook` is the CI command (`run`, not watch).
- Add `--coverage` to collect coverage; needs `@vitest/coverage-v8@4.1.11`.
- Shard heavy suites with `vitest run --shard=1/3` across parallel jobs.
- If you don't use the container image, `bunx playwright install chromium --with-deps`
  is required, and needs root — hence the container is simpler.
- `storybookUrl` / `SB_URL` only affects the clickability of failure links. If
  you publish Storybook (GitHub Pages, Vercel), switch the trigger to
  `on: deployment_status` and pass `github.event.deployment_status.environment_url`,
  per the docs.
- **If you adopt screenshot tests**, baselines must be generated in this same
  container. Add a documented `bun run test-storybook:ci -- --update` path that
  runs inside `docker run --rm -v $PWD:/w -w /w mcr.microsoft.com/playwright:v1.63.0-noble`,
  or the suite will be red on every machine that isn't CI.
- Node inside the Playwright image is ≥ 22, satisfying Storybook 10's floor.
  We use Bun for everything anyway.

---

## 10. Notable for a chat-UI component kit

**Story globals + per-project `initialGlobals`** (§2). Run the whole story set in
light and dark as two Vitest projects. For a chat UI — bubbles, code blocks,
syntax highlighting, tool-call cards — dark-mode contrast regressions are the
most likely a11y failure, and this catches them for free.

**Viewport is core**, no addon (`docs/essentials/viewport.mdx`). `MINIMAL_VIEWPORTS`
gives `mobile1` 320×568, `mobile2` 414×896, `tablet` 834×1112, `desktop` 1024×1280;
`INITIAL_VIEWPORTS` has ~29 named devices. Configure with `parameters.viewport.options`
and pin a story with `globals: { viewport: ... }` — when set via `globals` the
toolbar is locked, which is what you want for a "narrow composer" story. A chat
UI's hardest layout is the mobile composer, so pin dedicated stories at `mobile1`.

**`Story.extend` chains** (§6). Chat components have combinatorial states:
user/assistant × streaming/complete × with/without tool calls × error. `.extend`
expresses that as a lattice instead of copy-pasted arg objects, with args shallow
merged and tags concatenated.

**`subcomponents`** (`docs/writing-stories/stories-for-multiple-components.mdx`).
Documents a parent and its children on one page — `MessageList` +
`MessageBubble`, or `Composer` + `ComposerToolbar`. Two limitations: subcomponent
argTypes are inferred only (cannot be authored or overridden), and the
subcomponent table has no working controls (controls always target the main
component's args). Documentation aid, not an interaction surface.

**Reusing story args across stories.** Import another story file's args into a
composite story (`docs/writing-stories/stories-for-multiple-components.mdx`,
"Reusing story definitions") so a `Conversation` story is literally built from
the `Message` stories. Keeps fixture data in one place.

**`sb.mock` (new in 10).** Module mocking that works in both Vite and Webpack and,
crucially, **in static production builds** — so a story that mocks a streaming
transport or an SSE client still works in the deployed Storybook, not just in
dev. Inspired by `vi.mock`, but Storybook's own. This matters a lot for a chat
kit: streaming states are otherwise impossible to demo.

**`@storybook/addon-mcp@10.6.0` (Preview).** Serves an MCP endpoint at
`http://localhost:6006/mcp` while `storybook dev` runs, exposing three toolsets:
`docs` (reads a components manifest so an agent reuses your real components
instead of inventing markup), `development` (generate stories), and `testing`
(run interaction + a11y tests and self-heal). Requires
`features: { componentsManifest: true }` in `main.ts`; every React framework
supports the manifest. Tool names are `toolset-method` as of 10.6
(`stories-preview`, `docs-show`). Peers `@storybook/addon-vitest`.
Given that this repo's whole premise is agent-operated, this is the most
interesting thing in the release — an agent can be pointed at the design system
and made to verify its own UI changes.
https://storybook.js.org/docs/ai/mcp/overview

**`storybook skills` CLI.** Storybook ships agent skills served from the project:
`bunx storybook skills` lists `stories` ("the mandatory, ordered workflow for UI
changes"), `write-story`, and `setup`. `bunx storybook skills <id>` prints one.
`storybook init` ends by telling you to run `bunx storybook skills setup`.
Verbatim from the init output:

> Storybook is installed but is not entirely set up yet. To finish setting up,
> now run `bunx storybook skills setup` and follow its instructions precisely.

Given `.agents/skills/` in this repo, these are worth reading before writing our
own story conventions.

**`features.experimentalDocgenServer`.** Moves component analysis from the
browser to the Storybook server, reading each component from TypeScript source
once and feeding Controls, Docs and the agent-facing components manifest.
Becomes the default in Storybook 11. Currently default-on only for
`@storybook/angular-vite`.

**`storybook/highlight`** (core since 9) draws attention to DOM nodes from a play
function — useful for documenting focus order in a keyboard-navigable message
list.

**Change detection** (`docs/configure/user-interface/change-detection.mdx`) uses
git to mark which stories changed on the current branch. Works automatically in a
repo.

---

## Sources

- https://storybook.js.org/blog/storybook-10/
- https://storybook.js.org/docs/releases/migration-guide
- https://github.com/storybookjs/storybook/blob/v10.6.0/MIGRATION.md
- https://storybook.js.org/docs/writing-tests
- https://storybook.js.org/docs/writing-tests/integrations/vitest-addon
- https://storybook.js.org/docs/writing-tests/integrations/test-runner
- https://storybook.js.org/docs/writing-tests/accessibility-testing
- https://storybook.js.org/docs/writing-tests/visual-testing
- https://storybook.js.org/docs/writing-tests/snapshot-testing
- https://storybook.js.org/docs/writing-tests/in-ci
- https://storybook.js.org/docs/api/csf/csf-next
- https://storybook.js.org/docs/builders/vite
- https://storybook.js.org/docs/writing-docs/autodocs
- https://storybook.js.org/docs/writing-docs/mdx
- https://storybook.js.org/docs/essentials/viewport
- https://storybook.js.org/docs/ai/mcp/overview
- https://storybook.js.org/recipes/tailwindcss (stale for v4)
- https://github.com/storybookjs/storybook/blob/v10.6.0/code/addons/themes/docs/api.md
- https://github.com/storybookjs/storybook/blob/v10.6.0/code/core/src/common/js-package-manager/JsPackageManagerFactory.ts
- https://vitest.dev/guide/browser/visual-regression-testing
- https://tailwindcss.com/docs/dark-mode
- https://github.com/storybookjs/storybook/issues/31832 (bun monorepo lockfile, closed)
- https://github.com/storybookjs/storybook/issues/30654 (bun build stories, closed)
- https://github.com/storybookjs/storybook/issues/25389 (bun init, closed)
- https://github.com/storybookjs/storybook/issues/28970 (bun + postcss EISDIR, open)
- https://github.com/storybookjs/storybook/discussions/22521 (monorepo RFC, open)
- https://github.com/vercel/turborepo/discussions/6879
