# Content renderers

A content renderer draws a claimed fence language or file extension. It is
trusted code bundled by the application build. The [approved ruling](https://github.com/schlessera/brain-kit/pull/2102)
sets the scope; Mermaid and diagrams are its first intended implementations.
The seam is `@experimental` until 1.0.

## Implement

Import `ContentRendererPack` from `@schlessera/brain-ui-sdk/client`. Each entry
has `languages`, `extensions`, `Component`, `needsBrowser` and `toStatic`.
The component receives `{ source, path?, mode, theme }`; modes are `chat`,
`file`, `share`, and themes are `light`, `dark`, `print`. Parse source as data
and build elements. Never inject source markup into the page.

The static entry imports `StaticRendererPack` from
`@schlessera/brain-ui-sdk/render`. Its `toStatic(source, { theme, path? })`
returns HTML/SVG without script, event attributes or external resources.
Set `needsBrowser: true` when static rendering needs a browser; a caller
without one must retain the code block. Keep client imports out of this entry.

## Register at build time

Call `registerContentRenderers(pack)` from the client build entry.
`defaultContentRendererRegistry.forLanguage(language)` and
`.forExtension(extension)` perform exact, case-sensitive lookups; extensions
include the leading dot, including compound extensions like `.odyssey.yaml`.
Callers choose which extension to look up. A missing claim returns null;
the first claim wins. Registering the same pack object again is a no-op.
`createContentRendererRegistry()` provides an isolated registry with the same
API plus `has` and `reset` (which clears claims and registered-pack identity).

The static build independently calls `registerStaticRenderers(pack)` and
`staticRendererFor(languageOrExtension)` (language before extension on
ambiguity), or uses `createStaticRendererRegistry()`. Static registration
never imports a client component. Markdown/file dispatch and module manifest
discovery are not wired by this seam-only change.

## Prove the theme contract

Run `contentRendererConformance(pack, fixtures)` from
`@schlessera/brain-ui-sdk/testing` in a real browser test.
`fixtures.cases` is an array of `{ renderer: index, source, path? }`, with at
least one fixture per renderer. `fixtures.mount(renderer, props)` mounts the
real component and returns `{ element, dispose }`; `element` is the content
root, not a test wrapper. `dispose` unmounts it. Await the suite in your test;
a violation throws its reason. It drives each case in every mode/theme and
calls `toStatic` in all themes, including for browser-only static renderers.

Both outputs have one content root. Its computed print background must match
the document paper, `rgb(255, 255, 255)`. Palette literals belong to `--bk-*`
custom properties inside `<style data-content-renderer-tokens>`; paints
elsewhere refer to tokens. Print uses opaque tokens. The suite checks inline
styles, stylesheet rules, SVG paint attributes, computed fill/background alpha
and opacity, scripts, event attributes and external resource URLs. Fragment
references such as `url(#arrow)` are allowed. CSS imports and escaped resource
syntax are refused by this conservative authoring check. Static resources are
checked before output is connected for computed-style inspection.

This is a guard for trusted packs, not an HTML sanitizer. It does not prove
semantics, grayscale legibility, geometry or browser printing by itself. Add
those runtime/visual checks to each pack. Every artifact leaving the screen
uses `print`; explicit CLI theme selection is the export override.
