/** Process-death fixture: durable worker writes, real descriptors and publication. */
import { join } from "node:path";
import { createUiDb } from "../../src/db/client.js";
import { openSqliteWriter } from "../../src/db/write-worker.js";
import { createTrustSettings } from "../../src/brain/trust-settings.js";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { connect } from "node:net";
import { createGitHubReferenceAccess } from "../../src/brain/github-reference-access.js";
import { createTrustGitHubIdentity } from "../../src/brain/trust-github-identity.js";
const [root, at, request] = process.argv.slice(2) as [string, string, string];
const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
const fixtureFile = Bun.file(join(root, "github-fixture.json"));
const metadata = await fixtureFile.exists() ? await fixtureFile.json() as { principalId: string; port: number; ca: string } : null;
const github = metadata ? createTrustGitHubIdentity({ root, access: createGitHubReferenceAccess({ db, brain: "ithaca-brain",
  credentials: {}, transport: { async resolve() { throw new Error("No Git in Settings"); }, async fetch() { throw new Error("No Git in Settings"); }, async checkout() { throw new Error("No Git in Settings"); } },
  wireTransport: { ca: await Bun.file(metadata.ca).text(), lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: (() => connect({ host: "127.0.0.1", port: metadata.port })) as typeof connect } }) }) : undefined;
const settings = createTrustSettings({ root, db, writer, lock: createKeyedLock(), authority: () => "owner-epoch",
  ...(github ? { github } : {}),
  observe: async (_id, publish) => publish(), checkpoint: stage => { if (stage === at) process.exit(77); } });
const review = JSON.parse(await Bun.file(join(root, "request.json")).text());
if (at === "prepared") await settings.prepare(metadata?.principalId ?? "odysseus", review.input);
else await settings.commit(metadata?.principalId ?? "odysseus", { version: 1, requestId: request, reviewId: review.reviewId, reviewedBytesHash: review.reviewedBytesHash });
await writer.close(); db.close();
