/**
 * The `options` a Boat provider instance accepts. Strict: an unknown key is a
 * configuration error, so a setting this adapter deliberately does not
 * support (a setup script, files written at create, sandbox env, a base URL,
 * hosted ports) can never be passed through by accident.
 */

import { z } from "zod";

/** Boat's machine sizes (`CreateSandboxRequest.type`). */
export const BOAT_MACHINES = ["small", "default", "large", "xlarge"] as const;

export const boatOptionsSchema = z
  .object({
    /** Machine size. Omitted, Boat's default applies, or the size a `from` snapshot was saved from. */
    machine: z.enum(BOAT_MACHINES).optional(),
    /** A saved snapshot name (or share code) the sandbox starts from. The key then also needs `snapshot.read`. */
    from: z.string().min(1).max(255).optional(),
    /**
     * A Boat environment to attach. Omitted, the sandbox is created with
     * `noEnv` and receives none of the account's secrets or credentials.
     */
    environment: z.string().min(1).max(255).optional(),
    /** The organization wallet to bill, by id or name. */
    org: z.string().min(1).max(255).optional(),
  })
  .strict();

export type BoatOptions = z.infer<typeof boatOptionsSchema>;
