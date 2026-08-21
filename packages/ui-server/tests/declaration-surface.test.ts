/**
 * The optional backends must be optional at TYPE-CHECK time too — on BOTH
 * resolution paths this package ships.
 *
 * F1 made `@schlessera/brain-backend-claude` and `-pi` optional peers loaded
 * lazily — but a type position that names their specifier still forces
 * TypeScript to resolve them. That bit twice: `ModelSource` leaked through
 * `BackendRegistry.getModelSource()` into the emitted `.d.ts` (the `types`
 * condition consumer), and after that was scrubbed, `import type` +
 * `typeof import(...)` remained in `src` — which the `bun` condition consumer
 * (customConditions: ["bun"], as this repo's own root tsconfig sets) resolves
 * directly, hitting TS2307 for the absent peer.
 *
 * So this gate covers both: the real declaration emit (the build tsconfig, in
 * memory) must contain no backend specifier, and neither may ANY file under
 * `src/`. The price of a specifier-free `src` is that the lazily-required
 * Claude module is typed by hand-written structural mirrors — so the
 * type-level assertions at the bottom import the REAL package (tests may;
 * only src must stay clean) and fail the typecheck if a mirror drifts from
 * the thing it mirrors.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import ts from "typescript";
import type * as claude from "@schlessera/brain-backend-claude";
import type {
  ClaudeBackendModule,
  ClaudeModelSource,
  ClaudeProfile,
  ClaudeProfileInput,
  ModelDiscoveryState,
} from "../src/agent/backend";

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

  test("no file under src/ names an optional backend specifier in any position", () => {
    // The runtime specifier strings in agent/backend.ts (BACKEND_SPECIFIERS,
    // fed to `await import(variable)`) are the single exception: they are what
    // "lazy optional peer" means, and a non-literal dynamic import is a string
    // the compiler never resolves. Everything else — import, import type,
    // typeof import, and a LITERAL dynamic import — would force the peer onto
    // the bun-condition consumer's typecheck.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.ESNext,
          true
        );
        const visit = (node: ts.Node): void => {
          const specifier =
            ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
                ? node.argument.literal
                : ts.isCallExpression(node) &&
                    node.expression.kind === ts.SyntaxKind.ImportKeyword
                  ? node.arguments[0]
                  : undefined;
          if (
            specifier &&
            ts.isStringLiteralLike(specifier) &&
            BACKEND_SPECIFIER.test(specifier.text)
          ) {
            offenders.push(`${path.slice(PKG.length + 1)}: ${specifier.text}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    };
    walk(join(PKG, "src"));
    expect(offenders).toEqual([]);
  });
});

// --- mirror drift guard ------------------------------------------------------
//
// src types the lazily-required Claude module structurally so it never names
// the specifier. These assertions are where the compile-time link to the real
// module lives instead: if the real package's shape stops satisfying a mirror,
// `bunx tsc --noEmit` fails right here. Property-style function members in the
// mirrors keep the check contravariant under strictFunctionTypes.
type Assert<T extends true> = T;

// The whole module slice: the real module must be usable wherever the mirror
// is expected (this is exactly the `claude = require(...)` assignment).
type _moduleCompat = Assert<typeof claude extends ClaudeBackendModule ? true : false>;
// Discovery: the real source satisfies the internal view (list included)...
type _sourceCompat = Assert<claude.ModelSource extends ClaudeModelSource ? true : false>;
// ...and its state satisfies the public slice on BackendRegistry.
type _stateCompat = Assert<
  ReturnType<claude.ModelSource["state"]> extends ModelDiscoveryState ? true : false
>;
// Profiles, both directions of the boundary: mirror inputs must be accepted by
// the real defineProfiles, and real resolved profiles must satisfy the mirror.
type _inputCompat = Assert<ClaudeProfileInput extends claude.InferenceProfileInput ? true : false>;
type _profileCompat = Assert<claude.InferenceProfile extends ClaudeProfile ? true : false>;

describe("structural mirrors of the Claude module", () => {
  test("the type-level compatibility assertions above compiled", () => {
    // The real check is `bunx tsc --noEmit` on the Assert<> lines; this test
    // exists so their presence is executed and visible in the run.
    const witness: _moduleCompat & _sourceCompat & _stateCompat & _inputCompat & _profileCompat =
      true;
    expect(witness).toBe(true);
  });
});
