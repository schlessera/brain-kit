/** Separate bounded #2354 composition; default/shared app proofs remain complete. */
process.argv.push("--shared-git", "--probe-state-placement");
await import("./ordinary-identity-root.js");
export {};
