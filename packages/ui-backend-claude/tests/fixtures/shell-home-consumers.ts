/** Actual HOME-derived consumers inside the unprofiled native Claude worker. */
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEnv } from "../../../core/src/config/env.js";
import { geoConfigSchema } from "../../../geo/src/config.js";
import { GeoTransport } from "../../../geo/src/server/io.js";

let requests = 0;
const geo = new GeoTransport(geoConfigSchema.parse({ userAgent: "odysseus-geo-fixture/1.0", minimumIntervalMs: 0 }), {
  fetchImpl: async () => { requests++; return Response.json({ voyage: "Ithaca" }); },
});
const result = await geo.request("nominatim", "http://127.0.0.1:1", "http://127.0.0.1:1/ithaca", {}, value => value);
console.log("home-consumers=" + JSON.stringify({ home: homedir(), binDir: resolveEnv().binDir,
  geoDirectory: join(homedir(), ".cache", "brain-kit", "geo"), geoError: result.error?.code,
  requestSent: result.source.requestSent, requests }));
