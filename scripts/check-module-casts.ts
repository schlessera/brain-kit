// Refuses type assertions on module-contract config values in module sources.
//
// Why: `ModuleManifest<C>` validates the user's config block to `C`, and the
// module contract threads that type through `CommandContext<C>` and
// `HygieneContext<C>` (see packages/core/src/lib/module-types.ts). A module
// authored with `defineModule` + a configSchema gets `ctx.config` fully typed,
// so `ctx.config as MyConfig` is never necessary — and worse, it papers over a
// regression: if the generic is ever dropped again, casts keep every
// first-party module compiling and the loss lands silently on third-party
// authors. The compile test that pins the generic is
// packages/core/tests/module-author-typing.test.ts; this lint keeps the
// first-party modules honest so that test stays the only line of defense that
// matters.
//
// Deliberately narrow: only assertions applied to the CONTEXT CONFIG VALUE
// (`ctx.config as X`, `context.config as X`, `(ctx.config ?? {}) as X`) are
// banned. `as` in general stays available — banning it wholesale would drown
// the signal in noise the modules cannot satisfy.
import { readFileSync } from "fs";
import { resolve } from "path";

// An assertion directly on the config property of a command/hygiene context…
const DIRECT_CAST = /\b(?:ctx|context)\.config\s+as\s+/;
// …or on a parenthesized expression that starts with it, e.g. `(ctx.config ?? {}) as X`.
const WRAPPED_CAST = /\(\s*(?:ctx|context)\.config\b[^()]*\)\s*as\s+/;

interface Finding {
  file: string;
  line: number;
  text: string;
}

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (DIRECT_CAST.test(line) || WRAPPED_CAST.test(line)) {
      findings.push({ file, line: i + 1, text: line.trim() });
    }
  }
  return findings;
}

export async function scanModules(root: string): Promise<Finding[]> {
  const glob = new Bun.Glob("packages/module-*/src/**/*.{ts,tsx}");
  const findings: Finding[] = [];
  for (const relative of [...glob.scanSync({ cwd: root })].sort()) {
    const text = readFileSync(resolve(root, relative), "utf-8");
    findings.push(...scanText(relative, text));
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const findings = await scanModules(root);
  if (findings.length === 0) {
    console.log("No config casts in module sources.");
    process.exit(0);
  }

  console.error("Type assertions on module-contract config values found:");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}: ${finding.text}`);
  }
  console.error(
    "\nThe module contract already delivers this type: defineModule threads the " +
      "configSchema's parsed type through CommandContext<C> and HygieneContext<C>, " +
      "so `ctx.config` is typed with no cast. Type the command as " +
      "`CommandModule<MyConfig>` (or the check as `HygieneContext<MyConfig>`) " +
      "and drop the assertion."
  );
  process.exit(1);
}
