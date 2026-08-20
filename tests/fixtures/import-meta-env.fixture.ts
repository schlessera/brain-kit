// Fixture for the rule-4 gate in scripts/check-env-access.ts. Not compiled
// into anything — it exists so the detector is proven on both spellings a
// library actually uses, including the defensive cast that hides the read
// from a naive grep.
const direct = import.meta.env.VITE_BACKEND_URL;
const cast = (import.meta as { env?: Record<string, unknown> }).env?.DEV;
const bracketed = import.meta.env["VITE_OTHER"];

export { direct, cast, bracketed };
