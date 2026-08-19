/**
 * Fixtures for scripts/check-module-casts.ts — the lint that keeps first-party
 * modules from papering over the module-contract generic with a cast (the
 * companion to packages/core/tests/module-author-typing.test.ts, which is why
 * it lives here rather than in the repo-root tests/).
 *
 * Detection is AST-based, so these pin BOTH directions: the spellings of a
 * real config cast (including the multi-line form a formatter produces) must
 * be flagged, and mere mentions in comments or strings must not be.
 */
import { describe, expect, test } from "bun:test";

import { scanText } from "../../../scripts/check-module-casts";

function lines(text: string): number[] {
  return scanText("fixture.ts", text).map((f) => f.line);
}

describe("check-module-casts", () => {
  test("flags every spelling of a cast on the context config value", () => {
    const flagged = [
      `const a = ctx.config as FooConfig;`,
      `const b = context.config as FooConfig;`,
      `const c = (ctx.config ?? {}) as FooConfig;`,
      `const d = (ctx.config || {}) as FooConfig;`,
      `const e = ctx.config! as FooConfig;`,
      `const f = <FooConfig>ctx.config;`,
      `const g = ctx["config"] as FooConfig;`,
    ];
    for (const fixture of flagged) {
      expect(lines(fixture)).toEqual([1]);
    }
  });

  test("flags a cast split across lines by a formatter", () => {
    const fixture = [
      `const cfg = ctx.config as`,
      `  SomeExtremelyLongModuleConfigurationTypeName;`,
      `const other = (`,
      `  context.config ?? {}`,
      `) as AnotherConfig;`,
    ].join("\n");
    expect(lines(fixture)).toEqual([1, 3]);
    // The report collapses the break so each finding stays one line.
    expect(scanText("fixture.ts", fixture)[0]!.text).toBe(
      "ctx.config as SomeExtremelyLongModuleConfigurationTypeName"
    );
  });

  test("ignores casts that only appear in comments and strings", () => {
    const fixture = [
      `// never write ctx.config as FooConfig — the generic delivers the type`,
      `/* ctx.config as FooConfig */`,
      `const msg = "never write ctx.config as FooConfig";`,
      "const tpl = `context.config as ${name}Config`;",
    ].join("\n");
    expect(lines(fixture)).toEqual([]);
  });

  test("stays narrow: unrelated asserts and plain reads pass", () => {
    const fixture = [
      `const a = ctx.config;`, // no assertion
      `const b = other.config as FooConfig;`, // not a contract context
      `const c = ctx.configuration as FooConfig;`, // not the config property
      `const d = ctx.config as const;`, // narrows, doesn't paper over unknown
      `const e = someValue as SomethingElse;`, // `as` in general stays legal
      `const f = ctx.config satisfies FooConfig;`, // never changes the type
    ].join("\n");
    expect(lines(fixture)).toEqual([]);
  });
});
