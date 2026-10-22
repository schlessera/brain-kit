import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../../src/brain/host-boundary.js";
import { operationalStateMasks } from "../../src/brain/operational-state.js";
import { createNativeAppFixture } from "../helpers/native-app-fixture.js";

const root = "/opt/odysseus-layout", privateDir = "/opt/odysseus-private";
const brainPath = join(root, "brain"), dbPath = join(root, "state/linked.db"), tokenPath = join(root, "state/token");
const realDb = join(privateDir, "database/brain-ui.db"), realToken = join(privateDir, "tokens/poke-token");
symlinkSync(realDb, dbPath); symlinkSync(realToken, tokenPath);
const paths = { brainPath, dbPath, privateStatePaths: [{ setting: "BRAIN_UI_INBOX_POKE_TOKEN_FILE", path: tokenPath }] };
const native = createNativeAppFixture(brainPath);
try {
  const boundary = createHostBoundary({ ...paths, nativeManager: createNativeBrainManagerClient(native.nativeBrain) });
  const result = await boundary.run({ argv: [process.execPath, "--no-env-file", "-e",
    `for(const p of ${JSON.stringify([realDb, realToken, dbPath, tokenPath])}) if(await Bun.file(p).exists()) throw new Error("PRIVATE_STATE_LEAK:"+p); console.log("masked")`],
  env: {}, credentials: false, gate: "shared", purpose: "private state mask proof" });
  console.log(JSON.stringify({ result, masks: operationalStateMasks(paths) }));
} finally { await native.close(); }
