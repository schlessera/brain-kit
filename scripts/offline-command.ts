/** Isolate one test command. No child qualification or copied checkout. */
import { join } from "node:path";

export function offlineCommand(argv: string[]): string[] {
  return ["/usr/bin/python3", "-I", "-S", join(import.meta.dir, "offline-command.py"), ...argv];
}

/** Host Docker drivers also start without inherited provider credentials. */
export function cleanTestEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_ACCESS_KEY|ACCESS_KEY_ID|SESSION_TOKEN)$/.test(key) &&
    !["GOOGLE_APPLICATION_CREDENTIALS", "AWS_SHARED_CREDENTIALS_FILE", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"].includes(key)));
}
