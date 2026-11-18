/**
 * One real SQLite connection on a fictional index, opened with the product's
 * own opener in its own process, so its POSIX locks and shared-memory mapping
 * are a separate connection's rather than the test's (#2878).
 *
 * `seed` creates the table, `write` replaces its one value, `read` prints it,
 * and `hold` reads it read-only like a worker's `brain_search`, then keeps that
 * connection open until its stdin closes. `pin` does the same inside an open
 * read transaction, as a search still running holds its snapshot.
 */
import { openDatabase } from "../../../core/src/lib/db.ts";

const [mode, path, value] = process.argv.slice(2);
if (!path || !["seed", "write", "read", "hold", "pin"].includes(mode ?? "")) throw Error("INDEX_CONNECTION_USAGE");
const reader = mode === "read" || mode === "hold" || mode === "pin";
const db = openDatabase(path, { readonly: reader });
if (mode === "seed") { db.run("CREATE TABLE odysseus (value TEXT NOT NULL)"); db.run("INSERT INTO odysseus VALUES ('Ogygia')"); }
if (mode === "write") db.run("UPDATE odysseus SET value = ?", [value ?? "Ithaca"]);
if (mode === "pin") db.run("BEGIN");
if (reader) console.log(JSON.stringify(db.query("SELECT value FROM odysseus").get()));
if (mode === "hold" || mode === "pin") await new Response(Bun.stdin.stream()).text();
if (mode === "pin") db.run("COMMIT");
db.close();
