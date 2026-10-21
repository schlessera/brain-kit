/** Applied only to the original listing child via Node's supported --import. */
import { observation } from "./hosted-observer.mts";
observation("node.preload");
process.on("beforeExit", code => observation("node.beforeExit", { code }));
