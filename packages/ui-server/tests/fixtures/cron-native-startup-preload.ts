/** Explicit child-process input acquisition double; maintenance execution stays real. */
import { replaceNativeStartupAcquisitionForFixture } from "../helpers/fixture-native-startup.js";
const restore = replaceNativeStartupAcquisitionForFixture();
process.on("exit", restore);
