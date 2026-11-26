/** Isolate one test command. Browser commands alone request the route-free online indicator. */
import { join } from "node:path";
import names from "./test-credential-names.json";

export function offlineCommand(argv: string[], browser = false): string[] {
  return ["/usr/bin/python3", "-I", "-S", join(import.meta.dir, "offline-command.py"), ...(browser ? ["--browser-online"] : []), ...argv];
}

/** Host Docker drivers also start without inherited provider credentials. */
export function cleanTestEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !names.prefixes.some(prefix => key.startsWith(prefix)) && !names.suffixes.some(suffix => key.endsWith(suffix))));
}
