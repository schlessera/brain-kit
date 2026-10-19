/** Separate supported private-input qualification; never rewrites private modes. */
process.argv.push("--shared-git", "--private-git-inputs");
await import("./ordinary-identity-root.js");
export {};
