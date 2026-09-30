# DocumentRenderer is an internal adapter

The maintainer's [2026-09-28 ruling on #343, question 3](https://github.com/schlessera/brain-kit/issues/343#issuecomment-5865811500)
classifies core's `DocumentRenderer` as an internal adapter for the optional
`@schlessera/brain-render-puppeteer` dependency. It is not a public extension
interface and does not become one at 1.0.

## The existing boundary

The type describes the PDF, PNG and shutdown operations core uses from the
Puppeteer package (`DocumentRenderer`,
`packages/core/src/providers/renderers/puppeteer.ts:12-16`). It lives beside
that package's loader, marked `@internal`, rather than beside public provider
seams. Its only internal consumer is the loader's return type.

`resolveDocumentRenderer` dynamically imports that one optional package and
returns its `createRenderer` result. If the import fails, it explains how to
install the package and that HTML rendering works without it
(`resolveDocumentRenderer`, `packages/core/src/providers/renderers/puppeteer.ts:37-56`).
Core's public entry points do not export the adapter type or loader, and
configuration has no passed-in renderer or renderer registry.

The Puppeteer package exposes its own `createRenderer`, `Renderer`,
`RendererOptions` and `RenderOptions`. That public API, the CLI's rendering
behavior, renderer isolation, optional loading and HTML fallback keep their
existing guarantees. Classifying core's local adapter changes none of them.
The rendering-design and phase-budget decisions remain in
[document-render.md](document-render.md) and [renderer-budgets.md](renderer-budgets.md).

## Why reject a public renderer seam

There is one implementation and no identified second renderer that needs
provider injection. Turning the local adapter into an extension interface
would add registration and a compatibility obligation without a concrete
consumer. ROADMAP's binding rule requires a plausible second implementation
within a year before adding a seam.

Leaving the type beside public seams also obscures the boundary: its shape
looks like another supported provider despite being absent from the public
exports and seam inventory. Moving the unchanged type beside its concrete
loader makes its role explicit. A future concrete second renderer can justify
a separately designed interface; this type's existence does not decide that
future interface or freeze it now.
