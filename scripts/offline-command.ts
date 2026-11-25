/** Isolate one test command. Browser commands alone request the route-free online indicator. */
import { join } from "node:path";

export function offlineCommand(argv: string[], browser = false): string[] {
  return ["/usr/bin/python3", "-I", "-S", join(import.meta.dir, "offline-command.py"), ...(browser ? ["--browser-online"] : []), ...argv];
}

/** Host Docker drivers also start without inherited provider credentials. */
export function cleanTestEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_ACCESS_KEY|ACCESS_KEY_ID|SESSION_TOKEN)$/.test(key) &&
    !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|AWS_|GOOGLE_|VERTEX_|GCLOUD_|OPENAI|AZURE_OPENAI_|GEMINI_)/.test(key)));
}
