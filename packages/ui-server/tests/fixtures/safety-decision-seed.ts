/** Test-only committed-receipt seed for #3600's read projection. No product verdict writer. */
import type { Database } from "bun:sqlite";
export const url=import.meta.url;
export function setup(db:Database){return { seed(occurrenceId:string,sessionId:string){return db.transaction(()=>{
 const record=db.query("SELECT id,state FROM safety_records WHERE id=? AND kind='occurrence'").get(occurrenceId) as {id:string;state:string}|null;
 const terminal=db.query("SELECT state FROM safety_records WHERE occurrence_id=? AND kind='exposure'").get(occurrenceId) as {state:string}|null;
 if(!record||(terminal?.state??record.state)!=="finalized")throw new Error("Fixture decision needs finalized exposure");
 const session=db.query("SELECT * FROM safety_sessions WHERE session_id=?").get(sessionId) as {history_owner_id:string;generation:string;principal_id:string};
 const old=(db.query("SELECT revision FROM safety_meta").get() as {revision:string}).revision;
 const revision=String(BigInt(old)+1n);db.query("UPDATE safety_meta SET revision=?").run(revision);
 db.query("INSERT INTO safety_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(),occurrenceId,sessionId,session.history_owner_id,session.generation,revision,session.principal_id,crypto.randomUUID(),0,"safe","owner_history");
 }).immediate();} };}
