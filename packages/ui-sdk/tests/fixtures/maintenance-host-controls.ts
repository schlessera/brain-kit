/** Run the real maintenance boundary against an owned, unmasked fixture projection. */
import { runMaintenanceWorker, type MaintenanceCommand } from "../../src/server/maintenance-worker.js";
import { createFixtureMaintenanceHost } from "../helpers/worker-startup-view-fixture.js";

const input = JSON.parse(await Bun.stdin.text()) as MaintenanceCommand;
const fixture = createFixtureMaintenanceHost(input.brainPath);
try { console.log(JSON.stringify(await runMaintenanceWorker({ ...input, ...fixture }))); }
finally { fixture.cleanup(); }
