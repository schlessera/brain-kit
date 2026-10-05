import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "module";
import { dirname, join } from "path";
import { createRecordingObservability } from "../src/observability";
import {
  CORE_QUERIES_RANGE,
  createCoreQueryAccess,
  setCoreModuleLoaderForTesting,
  type CoreModuleLoader,
} from "../src/core-queries";

const real = createRequire(import.meta.url);
const realManifestPath = real.resolve("@schlessera/brain/package.json");
const realEntry = real("@schlessera/brain/queries") as Record<string, unknown>;

interface Staged {
  manifest?: { name?: unknown; version?: unknown } | Error;
  manifestPath?: string;
  entryPath?: string | Error;
  entry?: Record<string, unknown> | Error;
}

/** A loader that serves a staged installation and counts what it was asked. */
function staged(stage: Staged) {
  const calls: string[] = [];
  const loader: CoreModuleLoader = {
    resolve(specifier) {
      calls.push(`resolve ${specifier}`);
      if (specifier.endsWith("/package.json")) {
        if (stage.manifest === undefined) throw Object.assign(new Error("Cannot find package"), { code: "MODULE_NOT_FOUND" });
        return stage.manifestPath ?? "/opt/odysseus/node_modules/@schlessera/brain/package.json";
      }
      if (stage.entryPath instanceof Error) throw stage.entryPath;
      return stage.entryPath ?? "/opt/odysseus/node_modules/@schlessera/brain/src/queries/index.ts";
    },
    load(specifier) {
      calls.push(`load ${specifier}`);
      const value = specifier.endsWith("/package.json") ? stage.manifest : stage.entry;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { loader, calls };
}

const COMPLETE = { ...realEntry };
const OK_MANIFEST = { name: "@schlessera/brain", version: "0.40.0" };

afterEach(() => setCoreModuleLoaderForTesting(null));

function access(stage: Staged) {
  const { loader, calls } = staged(stage);
  setCoreModuleLoaderForTesting(() => loader);
  const observability = createRecordingObservability();
  const log = observability.logger("core-queries");
  return { access: createCoreQueryAccess({ log }), calls, observability };
}

describe("core query capability resolution", () => {
  test("the workspace's real core resolves with every graph and voice operation", () => {
    const resolved = createCoreQueryAccess();
    const graph = resolved.graph();
    const voice = resolved.voice();
    expect(graph.ok).toBe(true);
    expect(voice.ok).toBe(true);
    if (!graph.ok || !voice.ok) return;
    // The functions are core's own, not wrappers or copies.
    expect(graph.queries.readGraphMeta).toBe(realEntry.readGraphMeta as never);
    expect(voice.queries.readVoiceVocabulary).toBe(realEntry.readVoiceVocabulary as never);
    // ...from the installation whose manifest names the package.
    expect(dirname(realManifestPath)).toBe(dirname(real.resolve("@schlessera/brain/package.json")));
  });

  test("a usable staged installation exposes exactly its validated functions", () => {
    const { access: a } = access({ manifest: OK_MANIFEST, entry: COMPLETE });
    const graph = a.graph();
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(Object.keys(graph.queries).sort()).toEqual([
      "readGraphClusters", "readGraphDiscovery", "readGraphMaintenance", "readGraphMeta", "readGraphNeighborhood",
    ]);
  });

  const refusals: [string, Staged, string][] = [
    ["absent package", {}, "not_installed"],
    ["package without the ./queries entry", { manifest: OK_MANIFEST, entryPath: Object.assign(new Error("not exported"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }) }, "not_installed"],
    ["another package's manifest", { manifest: { name: "@odysseus/brain", version: "0.40.0" }, entry: COMPLETE }, "identity_mismatch"],
    ["an entry outside the manifest's package", { manifest: OK_MANIFEST, entryPath: "/opt/ithaca/queries/index.ts", entry: COMPLETE }, "identity_mismatch"],
    ["a release before the query entry", { manifest: { ...OK_MANIFEST, version: "0.39.0" }, entry: COMPLETE }, "version_unsupported"],
    ["an unchecked major line", { manifest: { ...OK_MANIFEST, version: "1.0.0" }, entry: COMPLETE }, "version_unsupported"],
    ["a manifest without a version", { manifest: { name: "@schlessera/brain" }, entry: COMPLETE }, "version_unsupported"],
    ["an unreadable manifest", { manifest: new Error("EACCES /opt/odysseus") }, "load_failed"],
    ["an entry that throws while loading", { manifest: OK_MANIFEST, entry: new Error("SyntaxError at /opt/odysseus") }, "load_failed"],
    ["an entry lacking a graph operation", { manifest: OK_MANIFEST, entry: { ...COMPLETE, readGraphDiscovery: undefined } }, "operation_missing"],
  ];
  for (const [name, stage, reason] of refusals) {
    test(`refuses ${name} as ${reason}`, () => {
      const { access: a } = access(stage);
      expect(a.graph()).toEqual({ ok: false, reason } as never);
    });
  }

  test("each feature checks only the operations it calls", () => {
    const { access: a } = access({ manifest: OK_MANIFEST, entry: { ...COMPLETE, readVoiceVocabulary: undefined } });
    expect(a.graph().ok).toBe(true);
    expect(a.voice()).toEqual({ ok: false, reason: "operation_missing" });
  });

  test("resolution is lazy, happens once per access, and reports each feature once without paths", () => {
    const { access: a, calls, observability } = access({ manifest: { ...OK_MANIFEST, version: "0.39.0" }, entry: COMPLETE });
    expect(calls).toEqual([]);
    for (let i = 0; i < 3; i++) {
      expect(a.graph().ok).toBe(false);
      expect(a.voice().ok).toBe(false);
    }
    expect(calls).toEqual([
      "resolve @schlessera/brain/package.json",
      "resolve @schlessera/brain/queries",
      "load @schlessera/brain/package.json",
    ]);
    const warnings = observability.logs.find({ severity: "WARN" });
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning.attributes).toEqual({ "core.reason": "version_unsupported", "core.required": CORE_QUERIES_RANGE, "core.version": "0.39.0" });
      expect(JSON.stringify(warning)).not.toContain("/opt/");
    }
  });

  test("a second access resolves afresh", () => {
    const { loader, calls } = staged({ manifest: OK_MANIFEST, entry: COMPLETE });
    setCoreModuleLoaderForTesting(() => loader);
    createCoreQueryAccess().graph();
    createCoreQueryAccess().graph();
    expect(calls.filter((c) => c === "load @schlessera/brain/queries")).toHaveLength(2);
  });

  test("the documented range is the one the manifest metadata advertises", async () => {
    const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
    expect(manifest.peerDependencies["@schlessera/brain"]).toBe("*");
    expect(manifest.peerDependenciesMeta["@schlessera/brain"]).toEqual({ optional: true });
    expect(CORE_QUERIES_RANGE).toBe(">=0.40.0 <1.0.0");
    // The workspace's own core is inside the range it is shipped with.
    expect(Bun.semver.satisfies((real("@schlessera/brain/package.json") as { version: string }).version, CORE_QUERIES_RANGE)).toBe(true);
  });
});
