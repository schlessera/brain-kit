/**
 * The optional backends must be optional at TYPE-CHECK time too.
 *
 * F1 made `@schlessera/brain-backend-claude` and `-pi` optional peers loaded
 * lazily — but an `import type` that reaches an EXPORTED declaration survives
 * into the emitted `.d.ts`, and then a pi-only TypeScript consumer must
 * install the Claude package (and its Anthropic Agent SDK) just to typecheck.
 * That is exactly how `ModelSource` leaked through
 * `BackendRegistry.getModelSource()` once already.
 *
 * This test runs the real declaration emit (the build tsconfig, in memory)
 * and fails if any emitted `.d.ts` references either backend package.
 * Internal `import type` / `typeof import(...)` usage remains fine — the
 * compiler drops what no public declaration needs, and this proves it.
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import ts from "typescript";

const PKG = resolve(import.meta.dir, "..");
const BACKEND_SPECIFIER = /@schlessera\/brain-backend-(claude|pi)/;

function emitDeclarations(): Map<string, string> {
  const configPath = join(PKG, "tsconfig.build.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { noEmit: false, declaration: true, emitDeclarationOnly: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    }
  );
  if (!parsed) throw new Error(`could not parse ${configPath}`);

  const emitted = new Map<string, string>();
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const result = program.emit(undefined, (fileName, text) => {
    if (fileName.endsWith(".d.ts")) emitted.set(fileName, text);
  });
  expect(result.emitSkipped).toBe(false);
  expect(emitted.size).toBeGreaterThan(0);
  return emitted;
}

describe("emitted declaration graph", () => {
  test("no public .d.ts references an optional backend package", () => {
    const offenders: string[] = [];
    for (const [fileName, text] of emitDeclarations()) {
      if (BACKEND_SPECIFIER.test(text)) {
        offenders.push(fileName.slice(PKG.length + 1));
      }
    }
    // A hit means an exported declaration's type reaches into a backend
    // package. Mirror the needed shape as a local structural interface
    // instead (see ModelDiscoverySource in src/agent/backend.ts).
    expect(offenders).toEqual([]);
  });
});
