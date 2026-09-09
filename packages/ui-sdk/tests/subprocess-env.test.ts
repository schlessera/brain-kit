import { describe, expect, test } from "bun:test";

import {
  SUBPROCESS_ENV,
  filterSubprocessEnv,
  parseSubprocessEnvExtra,
} from "../src/server";

describe("subprocess environment descriptor", () => {
  test("server-only entries are filtered behaviorally for every audience", () => {
    const serverOnly = [
      "COOKIE_SECRET",
      "BRAIN_UI_PASSWORD_HASH",
      "DEEPGRAM_API_KEY",
      "BRAIN_UI_SKILLS_GITHUB_TOKEN",
      "WEBAUTHN_RP_NAME",
      "WEBAUTHN_USER_NAME",
      "WEBAUTHN_USER_ID",
      "WEBAUTHN_RP_ID",
      "WEBAUTHN_ORIGINS",
      "BRAIN_UI_ALLOW_LOOPBACK_ORIGIN",
      "TRUST_PROXY",
      "TRUST_PROXY_HOPS",
      "PROXY_AUTH_HEADER",
      "ALLOWED_ORIGINS",
      "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH",
      "BRAIN_UI_ALLOW_PASSWORD",
    ] as const;
    const source = Object.fromEntries(
      serverOnly.map((name) => [name, "server-only-test-value"])
    );
    for (const audience of ["cron", "agent", "brainCli"] as const) {
      const filtered = filterSubprocessEnv(source, audience);
      for (const name of serverOnly) {
        expect(filtered[name]).toBeUndefined();
      }
    }
    expect(SUBPROCESS_ENV.CLAUDE_CODE_OAUTH_TOKEN).toContain("agent");
  });

  test("first-party CLI and module capability settings reach every audience", () => {
    const capabilityNames = [
      "SCRAPE_CHROME_URL",
      "CHROME_CDP_URL",
      "SCRAPE_CHROME_PATH",
      "SCRAPE_CHROME_NO_SANDBOX",
      "SCRAPE_USER_AGENT",
      "SCRAPE_RESPECT_ROBOTS",
      "OPENAI_BASE_URL",
      "GEMINI_BASE_URL",
      "BRAIN_ROOT",
      "BRAIN_RERANK_MODE",
      "XDG_BIN_HOME",
    ] as const;

    for (const name of capabilityNames) {
      expect(SUBPROCESS_ENV[name]).toEqual(["cron", "agent", "brainCli"]);
    }
  });

  test.each([
    ["cron", "DB_PATH", "HOME"],
    ["agent", "HOME", "DB_PATH"],
    ["brainCli", "NO_COLOR", "PI_CODING_AGENT_DIR"],
  ] as const)(
    "%s receives its audience variables but not another audience or unknown names",
    (audience, admitted, rejected) => {
      const filtered = filterSubprocessEnv(
        {
          [admitted]: "audience-value",
          [rejected]: "other-audience-value",
          FUTURE_OPERATOR_VARIABLE: "unknown-test-value",
          COOKIE_SECRET: "server-only-test-value",
        },
        audience
      );

      expect(filtered).toEqual({ [admitted]: "audience-value" });
    }
  );

  test.each(["cron", "agent", "brainCli"] as const)(
    "explicit extra names are admitted for %s without falling back to pass-through",
    (audience) => {
      const filtered = filterSubprocessEnv(
        {
          CUSTOM_PROFILE_TOKEN: "custom-token",
          UNLISTED_VARIABLE: "must-stay-out",
        },
        audience,
        ["CUSTOM_PROFILE_TOKEN"]
      );

      expect(filtered).toEqual({ CUSTOM_PROFILE_TOKEN: "custom-token" });
    }
  );

  test("the escape hatch admits valid names for every audience but never itself", () => {
    const extraNames = parseSubprocessEnvExtra(
      " CUSTOM_TOKEN, SECOND_TOKEN, CUSTOM_TOKEN, BRAIN_UI_SUBPROCESS_ENV_EXTRA "
    );

    for (const audience of ["cron", "agent", "brainCli"] as const) {
      expect(
        filterSubprocessEnv(
          {
            CUSTOM_TOKEN: "custom",
            SECOND_TOKEN: "second",
            BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CUSTOM_TOKEN",
          },
          audience,
          extraNames
        )
      ).toEqual({ CUSTOM_TOKEN: "custom", SECOND_TOKEN: "second" });
    }
  });

  test("escape-hatch parsing ignores empty, malformed, spaced, and duplicate entries", () => {
    expect(
      parseSubprocessEnvExtra(
        " , VALID_NAME,VALID_NAME,  SECOND_2  ,bad-name,has space,2INVALID,, "
      )
    ).toEqual(["VALID_NAME", "SECOND_2"]);
    expect(parseSubprocessEnvExtra(undefined)).toEqual([]);
    expect(parseSubprocessEnvExtra("")).toEqual([]);
  });
});
