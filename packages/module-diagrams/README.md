# Diagrams module

The module scaffold provides `brain diagram --help` and upstream review
tooling. Checking, geometry, renderers and an authoring skill are implemented
by subsequent work; the `ui` and `render` entries currently export nothing.

Enable the module in a brain configuration:

```ts
modules: {
  "@schlessera/brain-module-diagrams": {},
}
```

Run `brain module lint diagrams` to validate the configured module.

[UPSTREAM.md](UPSTREAM.md) explains how to review the pinned upstream method.
`upstream.json` records the last reviewed state; the module's [LICENSE](LICENSE)
contains the attribution for adapted rules, budgets and type grammars.
Upstream examples and HTML are never vendored.
