/**
 * Compute configuration and resolution (#3105): instance ids, finite leases,
 * credentials by variable name, built-ins loaded lazily, and two instances of
 * one implementation kept separately configured and authorized.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { brainConfigSchema } from "../src/lib/config";
import { COMPUTE_PROVIDERS, loadComputePackage, resolveComputeInstance, type ComputeBuiltin } from "../src/lib/registry";
import { PENELOPE, fakeClock, sandbox, service, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute } from "./helpers/compute/memory-provider";

let box: Sandbox | undefined;
afterEach(() => box?.dispose());

describe("compute config schema", () => {
  const parse = (compute: unknown) => brainConfigSchema.safeParse({ compute });

  test("accepts built-in names and values per instance, and no compute key at all", () => {
    expect(brainConfigSchema.safeParse({}).success).toBe(true);
    const memory = memoryCompute();
    expect(parse({
      providers: {
        "boat-small": { provider: "boat", apiKeyEnv: "BOAT_CI_KEY", options: { machine: "small" }, lease: { maxSeconds: 3600 }, maxConcurrent: 2 },
        "ithaca-host": { provider: memory.provider, lease: { maxSeconds: 1800 }, hourlyCeilingUsd: 0.1, retainOnRelease: true },
      },
    }).success).toBe(true);
  });

  test("requires a finite lease, a variable name for the key, valid ids and known keys", () => {
    const base = { provider: "boat", lease: { maxSeconds: 60 } };
    expect(parse({ providers: { a: { provider: "boat" } } }).success).toBe(false);
    expect(parse({ providers: { a: { ...base, lease: { maxSeconds: Infinity } } } }).success).toBe(false);
    expect(parse({ providers: { a: { ...base, lease: { maxSeconds: 0 } } } }).success).toBe(false);
    expect(parse({ providers: { a: { ...base, apiKeyEnv: "sk-live-not-a-name" } } }).success).toBe(false);
    expect(parse({ providers: { "Boat Small": base } }).success).toBe(false);
    expect(parse({ providers: { a: { ...base, apiKey: "inline" } } }).success).toBe(false);
    expect(parse({ providers: { a: { ...base, provider: { id: "half" } } } }).success).toBe(false);
    expect(parse({ providers: { a: base }, default: "a" }).success).toBe(false);
  });
});

describe("resolving compute instances", () => {
  test("two instances of one implementation get their own options and their own credential", async () => {
    box = sandbox();
    const clock = fakeClock();
    const memory = memoryCompute({ clock });
    const svc = service(box, {
      providers: {
        "ithaca-small": { provider: memory.provider, apiKeyEnv: "ITHACA_KEY", options: { region: "ithaca" }, lease: { maxSeconds: 600 } },
        "pylos-large": { provider: memory.provider, apiKeyEnv: "PYLOS_KEY", options: { region: "pylos" }, lease: { maxSeconds: 600 } },
      },
    }, { clock, env: { ITHACA_KEY: "key-for-ithaca", PYLOS_KEY: "key-for-pylos" } });
    const a = await svc.run(PENELOPE, { instance: "ithaca-small", argv: ["exit", "0"] });
    const b = await svc.run(PENELOPE, { instance: "pylos-large", argv: ["exit", "0"] });
    expect([a.ok, b.ok]).toEqual([true, true]);
    const seen = memory.calls
      .filter((c) => c.method === "allocate")
      .map((c) => ({ instance: c.instanceId, secret: c.secret, options: c.options }));
    expect(seen).toEqual([
      { instance: "ithaca-small", secret: "key-for-ithaca", options: { region: "ithaca" } },
      { instance: "pylos-large", secret: "key-for-pylos", options: { region: "pylos" } },
    ]);
  });

  test("an instance whose credential is unset is unavailable while its sibling still runs", async () => {
    box = sandbox();
    const memory = memoryCompute();
    const svc = service(box, {
      providers: {
        "ithaca-small": { provider: memory.provider, apiKeyEnv: "ITHACA_KEY", lease: { maxSeconds: 600 } },
        "pylos-large": { provider: memory.provider, apiKeyEnv: "PYLOS_KEY", lease: { maxSeconds: 600 } },
      },
    }, { env: { ITHACA_KEY: "key-for-ithaca" } });
    const pylos = await svc.run(PENELOPE, { instance: "pylos-large", argv: ["exit", "0"] });
    expect(pylos.ok ? "ran" : pylos.code).toBe("provider_unavailable");
    expect(pylos.ok ? "" : pylos.reason).toContain("PYLOS_KEY");
    expect((await svc.run(PENELOPE, { instance: "ithaca-small", argv: ["exit", "0"] })).ok).toBe(true);
  });

  test("a built-in reads its default variable unless the instance names its own", async () => {
    const memory = memoryCompute();
    const registry: Record<string, ComputeBuiltin> = {
      ogygia: { load: async () => ({ provider: memory.provider, keyEnv: "OGYGIA_API_KEY" }) },
    };
    const env = { OGYGIA_API_KEY: "default-key", OGYGIA_CI_KEY: "ci-key" };
    const plain = await resolveComputeInstance("plain", { provider: "ogygia", lease: { maxSeconds: 60 } }, { env, registry });
    const own = await resolveComputeInstance("own", { provider: "ogygia", apiKeyEnv: "OGYGIA_CI_KEY", lease: { maxSeconds: 60 } }, { env, registry });
    expect([plain.ok && plain.instance.secret, own.ok && own.instance.secret]).toEqual(["default-key", "ci-key"]);
    expect([plain.ok && plain.instance.keyEnv, own.ok && own.instance.keyEnv]).toEqual(["OGYGIA_API_KEY", "OGYGIA_CI_KEY"]);
  });

  test("boat resolves the first-party package, and needs its key", async () => {
    expect(Object.keys(COMPUTE_PROVIDERS)).toEqual(["boat"]);
    const unset = await resolveComputeInstance("boat-small", { provider: "boat", apiKeyEnv: "BOAT_CI_KEY", lease: { maxSeconds: 60 } }, { env: {} });
    expect(unset.ok ? "resolved" : [unset.code, unset.reason.includes("BOAT_CI_KEY")]).toEqual(["provider_unavailable", true]);
    const plain = await resolveComputeInstance("boat-small", { provider: "boat", options: { machine: "small" }, lease: { maxSeconds: 60 } }, { env: { BRAIN_COMPUTE_BOAT_API_KEY: "boat-key" } });
    expect(plain.ok && [plain.instance.provider.id, plain.instance.keyEnv, plain.instance.options]).toEqual(["boat", "BRAIN_COMPUTE_BOAT_API_KEY", { machine: "small" }]);
  });

  test("a first-party package that is not installed is unavailable with the install it needs", async () => {
    await expect(loadComputePackage("@schlessera/brain-compute-ogygia")).rejects.toThrow("@schlessera/brain-compute-ogygia is not installed; install it beside @schlessera/brain");
  });

  test("an installed package missing one of its own dependencies is not called uninstalled", async () => {
    box = sandbox();
    const module = join(box.base, "brain-compute-calypso.ts");
    writeFileSync(module, "import \"@schlessera/brain-compute-calypso-transport\";\nexport const computeProvider = {};\n");
    const failure = await loadComputePackage(module).then(() => "loaded", (error: Error) => error.message);
    expect(failure).not.toContain("is not installed");
    expect(failure).toContain(`${module} is installed but cannot load its dependency @schlessera/brain-compute-calypso-transport`);
    const registry: Record<string, ComputeBuiltin> = { calypso: { load: () => loadComputePackage(module) } };
    const r = await resolveComputeInstance("c", { provider: "calypso", lease: { maxSeconds: 60 } }, { env: {}, registry });
    expect(r.ok ? "resolved" : r.code).toBe("provider_unavailable");
  });

  test("a built-in package is loaded lazily by its exports, and a missing package is unavailable", async () => {
    box = sandbox();
    const memory = memoryCompute();
    (globalThis as { __ogygiaProvider?: unknown }).__ogygiaProvider = memory.provider;
    try {
      const module = join(box.base, "brain-compute-ogygia.ts");
      writeFileSync(module, "export const computeProvider = (globalThis as any).__ogygiaProvider;\nexport const defaultKeyEnv = \"OGYGIA_API_KEY\";\n");
      const registry: Record<string, ComputeBuiltin> = {
        ogygia: { load: () => loadComputePackage(module) },
        absent: { load: () => loadComputePackage(join(box!.base, "no-such-package.ts")) },
      };
      const loaded = await resolveComputeInstance("o", { provider: "ogygia", lease: { maxSeconds: 60 } }, { env: { OGYGIA_API_KEY: "k" }, registry });
      expect(loaded.ok && [loaded.instance.provider === memory.provider, loaded.instance.keyEnv, loaded.instance.secret]).toEqual([true, "OGYGIA_API_KEY", "k"]);
      const absent = await resolveComputeInstance("a", { provider: "absent", lease: { maxSeconds: 60 } }, { env: {}, registry });
      expect(absent.ok ? "resolved" : absent.code).toBe("provider_unavailable");
    } finally {
      // Removed even when an assertion fails, so no later file sees the stand-in.
      delete (globalThis as { __ogygiaProvider?: unknown }).__ogygiaProvider;
    }
  });

  test("an unknown built-in is provider_unknown and invalid options are provider_unavailable", async () => {
    const unknown = await resolveComputeInstance("x", { provider: "argo", lease: { maxSeconds: 60 } }, { env: {} });
    expect(unknown.ok ? "resolved" : unknown.code).toBe("provider_unknown");
    expect(unknown.ok ? "" : unknown.reason).toContain("Available built-ins: boat");
    const memory = memoryCompute();
    const bad = await resolveComputeInstance("x", { provider: memory.provider, options: { region: "troy" }, lease: { maxSeconds: 60 } }, { env: {} });
    expect(bad.ok ? "resolved" : bad.code).toBe("provider_unavailable");
    const inherited = await resolveComputeInstance("x", { provider: "toString", lease: { maxSeconds: 60 } }, { env: {} });
    expect(inherited.ok ? "resolved" : inherited.code).toBe("provider_unknown");
  });
});
