import type { Database } from "bun:sqlite";
import { providerAllows, type EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { Taxonomy } from "./taxonomy.js";

/** Keyword indexing and asset descriptions are independent of this policy. */
export function embedsType(taxonomy: Taxonomy, type: string): boolean {
  return taxonomy.types[type]?.embed !== false;
}

/** Bound SQL predicate for a query whose document table is aliased as `d`. */
export function embeddingEligibilitySql(taxonomy: Taxonomy, excludedDocuments: readonly number[] = []): { sql: string; params: string[] } {
  const params = Object.keys(taxonomy.types).filter((type) => !embedsType(taxonomy, type));
  const typeSql = params.length ? `d.type NOT IN (${params.map(() => "?").join(",")})` : "1";
  // IDs are integers obtained from this connection, never interpolated input.
  if (excludedDocuments.some(id => !Number.isSafeInteger(id) || id < 0)) throw new Error("Invalid provider eligibility document identity");
  return {
    sql: excludedDocuments.length ? `(${typeSql}) AND d.id NOT IN (${excludedDocuments.join(",")})` : typeSql,
    params,
  };
}

/** Derived row identities are scoped to this connection's current document inventory. */
export function providerExcludedDocuments(db: Database, rules: EffectiveGovernancePolicy["providers"], recipient: string | undefined): number[] {
  return (db.query("SELECT id,path,type FROM documents").all() as Array<{id:number;path:string;type:string}>)
    .filter(doc => !providerAllows(rules, doc.path, doc.type, recipient)).map(doc => doc.id);
}
