import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME!;
const scratch = "/tmp/odysseus-pi-auth";
mkdirSync(scratch, { recursive: true });
const source = readFileSync(join(home, "auth.json"), "utf8");
writeFileSync(join(scratch, "auth.json"), source);
writeFileSync(
  join(scratch, "models.json"),
  readFileSync(join(home, "models.json"))
);
let refreshes = 0;
const original = fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  if (String(input) !== "https://platform.claude.com/v1/oauth/token")
    throw new Error("Offline fixture request refused");
  refreshes++;
  return Response.json({
    access_token: "sk-ant-oat-odysseus-refreshed",
    refresh_token: "odysseus-refresh-two",
    expires_in: 3600,
  });
}) as typeof fetch;
try {
  const runtime = await ModelRuntime.create({
    authPath: join(scratch, "auth.json"),
    modelsPath: join(scratch, "models.json"),
    modelsStorePath: join(scratch, "models-store.json"),
    refreshOnCreate: false,
  });
  const command = await runtime.getAuth(runtime.getModels("openai")[0]!);
  const refreshed = await runtime.getAuth(runtime.getModels("anthropic")[0]!);
  let directHostAuthRefused = false;
  try {
    const host = await ModelRuntime.create({
      authPath: join(home, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await host.getAuth(host.getModels("anthropic")[0]!);
  } catch {
    directHostAuthRefused = true;
  }
  console.log(
    JSON.stringify({
      commandKey: command?.auth.apiKey,
      commandHeader: command?.auth.headers?.["x-odysseus-home"],
      refreshes,
      refreshed: refreshed?.auth.apiKey === "sk-ant-oat-odysseus-refreshed",
      scratchRotation: JSON.parse(
        readFileSync(join(scratch, "auth.json"), "utf8")
      ).anthropic.refresh,
      scratchAuth: readFileSync(join(scratch, "auth.json"), "utf8"),
      hostUnchanged: readFileSync(join(home, "auth.json"), "utf8") === source,
      directHostAuthRefused,
    })
  );
} finally {
  globalThis.fetch = original;
}
