import type { Principal } from "./db/principals.js";

/** Request-scoped values populated by the authentication boundary. */
export type AppEnv = {
  Variables: {
    principal?: Principal;
  };
};
