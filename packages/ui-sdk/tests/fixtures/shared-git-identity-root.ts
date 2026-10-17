/** Fresh documented shared-Git envelope, separate from original private-metadata evidence.
 * Public hosting contract pinned at 76cd61f6d5f2b97df5b61cdc836a86e05e9a36dd:
 * docs/worker-identities.md:105-109; docs/decisions/container-privilege.md:117-120,144-159.
 * No existing private Git metadata is migrated or chmodded by this fixture.
 */
process.argv.push("--shared-git");
await import("./ordinary-identity-root.js");
export {};
