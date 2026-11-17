import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ConnectionGate, createBrainUiRoot } from "../../src/index.ts";
import { registerPasskey } from "../../src/lib/passkeys.ts";

// The passkey login screen (#2555), in the real app: the public ConnectionGate
// shows LoginScreen until the host says this browser is signed in.
const root = createBrainUiRoot({ storagePrefix: "odysseus-passkey-login", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });
const mount = document.getElementById("app");
if (!mount) throw new Error("Passkey login fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ConnectionGate, { children: createElement("p", { id: "signed-in" }, "Signed in to Ithaca") }) }));

Object.assign(window, {
  __passkey: {
    /** Signs in with the password, then registers one passkey on the virtual authenticator. */
    async register(password: string) {
      await root.api.login(password);
      await registerPasskey(root.api, "Ithaca key");
    },
  },
});
