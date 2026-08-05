import { describe, expect, test } from "bun:test";
import { resolve } from "path";

import { buildTaxonomy } from "@schlessera/brain";
import type { LoadedModule } from "@schlessera/brain";

import manifest, { configSchema } from "../src/module";
import {
  buildPortfolio,
  computeClient,
  loadLedgers,
  type FinanceOptions,
} from "../src/finance";

const PKG_DIR = resolve(import.meta.dir, "..");

const OPTS: FinanceOptions = {
  root: resolve(import.meta.dir, "fixtures"),
  clientsDir: "clients",
  feeTolerance: 30,
  defaultCurrency: "USD",
  defaultTermsDays: 30,
};

const AS_OF = "2026-02-01"; // before every fixture invoice's due date

function reportFor(slug: string) {
  const pf = buildPortfolio(OPTS, slug, AS_OF);
  const c = pf.clients.find((x) => x.slug === slug);
  if (!c) throw new Error(`no report for ${slug}`);
  return c;
}

describe("ledger computation", () => {
  test("loads all fixture ledgers", () => {
    const ledgers = loadLedgers(OPTS);
    expect(ledgers.map((l) => l.slug).sort()).toEqual(["acme-corp", "globex", "initech"]);
  });

  test("partial payment leaves the invoice partial with the right open balance", () => {
    const c = reportFor("acme-corp");
    const inv01 = c.invoices.find((i) => i.number === "2026-acme-corp-01")!;
    const inv02 = c.invoices.find((i) => i.number === "2026-acme-corp-02")!;
    expect(inv01.status).toBe("paid");
    expect(inv01.open).toBe(0);
    expect(inv02.status).toBe("partial");
    expect(inv02.paid).toBe(1000);
    expect(inv02.open).toBe(1000);
    expect(c.open).toBe(1000);
  });

  test("a shortfall within fee tolerance settles the invoice as paid", () => {
    const c = reportFor("globex");
    const inv = c.invoices[0];
    expect(inv.paid).toBe(975);
    expect(inv.open).toBe(0);
    expect(inv.status).toBe("paid");
    expect(c.open).toBe(0);
  });

  test("a shortfall above fee tolerance stays open", () => {
    const ledger = loadLedgers(OPTS, "globex")[0];
    const strict = computeClient(ledger, 10, AS_OF); // tolerance below the 25 shortfall
    expect(strict.invoices[0].open).toBe(25);
    expect(strict.invoices[0].status).toBe("partial");
  });

  test("a written_off invoice carries the written_off status", () => {
    const c = reportFor("initech");
    expect(c.invoices[0].status).toBe("written_off");
  });
});

describe("module manifest", () => {
  test("configSchema fills defaults", () => {
    expect(configSchema.parse({})).toEqual({
      clientsDir: "clients",
      feeTolerance: 30,
      currency: "USD",
      termsDays: 30,
    });
  });

  test("configSchema accepts the documented config block", () => {
    expect(() => configSchema.parse({ clientsDir: "clients", feeTolerance: 30 })).not.toThrow();
  });

  test("taxonomy roundtrip: dirForType/typeForPath are inverse for finance", () => {
    const cfg = configSchema.parse({});
    const loaded: LoadedModule = {
      key: "@schlessera/brain-module-finance",
      manifest: { name: manifest.name, ...manifest.setup(cfg) },
      dir: PKG_DIR,
      config: cfg,
    };
    const tax = buildTaxonomy({ modules: [loaded] });
    const dir = tax.dirForType("finance");
    expect(dir).toBe("clients");
    expect(tax.typeForPath(`${dir}/x.md`)).toBe("finance");
  });

  test("setup shapes the finance dir from clientsDir", () => {
    const custom = manifest.setup(configSchema.parse({ clientsDir: "accounts" }));
    expect(custom.taxonomy?.types?.finance?.dir).toBe("accounts");
  });
});
