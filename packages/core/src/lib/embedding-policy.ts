import type { Taxonomy } from "./taxonomy.js";

/** Keyword indexing and asset descriptions are independent of this policy. */
export function embedsType(taxonomy: Taxonomy, type: string): boolean {
  return taxonomy.types[type]?.embed !== false;
}

/** Bound SQL predicate for a query whose document table is aliased as `d`. */
export function embeddingEligibilitySql(taxonomy: Taxonomy): { sql: string; params: string[] } {
  const params = Object.keys(taxonomy.types).filter((type) => !embedsType(taxonomy, type));
  return {
    sql: params.length ? `d.type NOT IN (${params.map(() => "?").join(",")})` : "1",
    params,
  };
}
