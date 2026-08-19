/**
 * Fixture for the env-read detector in `tests/env-parity.test.ts`.
 *
 * Every read form a chokepoint file can plausibly use, so the detector is
 * proven rather than assumed. Never imported at runtime; it exists to be
 * parsed.
 */

export function directRead(): string | undefined {
  return process.env.DIRECT_READ;
}

export function bracketRead(): string | undefined {
  return process.env["BRACKET_READ"];
}

/** The dominant form in this repo: the environment arrives as a parameter. */
export function typedParamRead(env: NodeJS.ProcessEnv): string | undefined {
  return env.TYPED_PARAM_READ;
}

export function defaultedParamRead(env = process.env): string | undefined {
  return env.DEFAULTED_PARAM_READ;
}

export function aliasedRead(): string | undefined {
  const local = process.env;
  return local.ALIASED_READ;
}

/** A dynamic read carries no literal name; nothing to declare, nothing to find. */
export function dynamicRead(name: string, env = process.env): string | undefined {
  return env[name];
}

/** Not an environment read: a SCREAMING_CASE field on an unrelated object. */
const unrelated = { NOT_AN_ENV_VAR: "x" };
export const notAnEnvRead = unrelated.NOT_AN_ENV_VAR;
