// happy-dom registration for render tests, scoped so it cannot leak.
//
// `bun test` runs every test file in ONE process, so a global DOM registered
// here would still be visible to whatever non-DOM test file runs next — and
// plenty of code in this repo branches on `typeof window`. The containment
// contract is therefore:
//
//   1. This module registers the DOM at import time (a `beforeAll` would be
//      too late: component modules touch browser globals while they load, and
//      imports evaluate before hooks run). A render test file must list
//      `import { unregisterDom } from "./dom.js"` FIRST so this evaluates
//      before any component import. Caveat: Bun runs CommonJS dependencies
//      during the link phase, before ANY ESM module body — so anything a CJS
//      module binds at load time (e.g. @testing-library/dom's `screen`)
//      predates the DOM. Render tests therefore use the queries returned by
//      `render()`, never `screen`. The same holds for react-dom's own
//      `canUseDOM`: evaluated before the DOM, it takes the input-event
//      polyfill, which resolves a keydown through the FOCUSED element and
//      throws when none is. A test that presses a key in a field focuses
//      the field first, as a typing user has.
//   2. The importing test file calls `afterAll(unregisterDom)`, which restores
//      the pre-registration globals before the next test file loads.
//   3. Because the module cache means step 1 runs only once per process, all
//      render tests live in ONE file (render-smoke.test.tsx). A second file
//      importing this module after unregistration would get no DOM — add new
//      render tests to that file instead of creating siblings.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}

// React 18+ requires this before act()-wrapped renders outside a real browser;
// @testing-library/react wraps every render in act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function unregisterDom(): void {
  if (GlobalRegistrator.isRegistered) {
    void GlobalRegistrator.unregister();
  }
}
