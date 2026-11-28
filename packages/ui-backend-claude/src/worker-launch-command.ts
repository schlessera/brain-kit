/** One ordinary-worker launch policy for the runtime and its brain subprocesses. */
import { brainWorkerPath } from "@schlessera/brain-common/internal/worker-areas";
import { workerExecHelpers, WORKER_EMPTY_HOME } from "@schlessera/brain-ui-sdk/internal";
import { wrapCommand, type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import { homedir } from "node:os";

export function ordinaryWorkerLaunch(brainPath: string, command: string[], env: Record<string, string | undefined>, config: ExecWrapperConfig) {
  workerExecHelpers({ wrapper: config.wrapper });
  const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  childEnv.PATH = brainWorkerPath(brainPath, childEnv.PATH);
  childEnv.HOME = WORKER_EMPTY_HOME;
  // Descendant shells must not import operator startup files or functions.
  for (const name of Object.keys(childEnv)) {
    if (["BASH_ENV", "ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS"].includes(name)
      || (name.startsWith("BASH_FUNC_") && name.endsWith("%%"))) delete childEnv[name];
  }
  return { command: wrapCommand(command, config.wrapper), env: childEnv, hostHome: env.HOME || homedir() };
}
