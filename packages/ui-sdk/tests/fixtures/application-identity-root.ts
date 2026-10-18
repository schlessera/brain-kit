/** Real positive private/Git history followed by the unchanged application cases. */
process.argv.push("--shared-git", "--private-git-inputs", "--application-qualification");
await import("./ordinary-identity-root.js");
export {};
