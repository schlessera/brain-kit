/** Values an autonomous worker must never observe (#676). They travel reversed in any argv or prompt. */
export const MARKERS = {
  realKey: "sk-odysseus-REAL-INFERENCE-KEY",
  hostEnv: "ODYSSEUS-HOST-ENV-SECRET",
  hostFile: "ODYSSEUS-HOST-FILE-SECRET",
  storedLogin: "ODYSSEUS-STORED-LOGIN-SECRET",
  ambient: "ODYSSEUS-AMBIENT-INSTRUCTION",
};
