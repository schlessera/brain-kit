/** Authenticated history operations, with durable identity and journal-owned storage. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { JournalVersion, TurnRevertPlan, TurnRevertReceipt, TurnRevertPath, TurnRevertRequest, TurnHistoryAction, ConflictVersionSelection, JournalObservationReference } from "@schlessera/brain-ui-sdk/protocol";
import { BRAIN_LOCK_KEY, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { GIT_LOCK_KEY } from "@schlessera/brain-ui-sdk/internal";
import type { TurnJournal } from "./turn-journal.js";
import type { WriterGate } from "./writer-gate.js";
import { processAlive, SELF } from "./writer-gate.js";
import { reversibleJournalPath, restoreJournalPath, createJournalSibling } from "./revert-files.js";
import { recordGovernanceEvent } from "../governance/events.js";

export class RevertUnavailable extends Error {}
type Selected = TurnRevertPath & { before: JournalVersion | null; after: JournalVersion | null; beforeSequence: number; afterSequence: number; other?: JournalVersion; otherSequence?: number };
type Operation = { id: string; principal_id: string; session_id: string; source_turn_id: string; journal_turn_id: string; fingerprint: string; action: TurnHistoryAction; selection: string; state: TurnRevertReceipt["state"]; pid: number; pid_start: string; error: string };
const same = (left: JournalVersion | null, right: JournalVersion | null) => JSON.stringify(left) === JSON.stringify(right);
const prefix = (path: string, parent: string) => parent === "." || path === parent || path.startsWith(`${parent}/`);

export function createTurnReverts(db: Database, options: {
  brainPath: string; journal: TurnJournal; gate: WriterGate; lock: KeyedLock;
  isAuthorized(principalId: string): boolean;
  refresh(): void;
}) {
  const journal = options.journal, running = new Map<string, Promise<void>>(), shutdown = new AbortController();
  function select(sessionId: string, turnId: string, action: "revert" | "restore"): Selected[] {
    const details = journal.details(sessionId, turnId);
    if (!details || !["complete", "partial"].includes(details.summary.state) || !["interactive", "user"].includes(details.summary.actor ?? "")) throw new RevertUnavailable("This turn is not available for a user history operation.");
    const reconciliation = db.query("SELECT reconciliation FROM governed_turn_manifests WHERE turn_id=? AND ended_at IS NOT NULL").get(turnId) as { reconciliation: string | null } | null;
    const quarantined = reconciliation?.reconciliation ? (JSON.parse(reconciliation.reconciliation) as { quarantined: {path:string}[] }).quarantined.map(item => item.path) : [];
    const folded = new Map<string, Selected>();
    for (const change of details.changes) {
      const first = folded.get(change.path);
      folded.set(change.path, { path: change.path, before: first ? first.before : change.before, after: change.after,
        beforeSequence: first?.beforeSequence ?? change.sequence, afterSequence: change.sequence,
        state: "eligible", reason: null, quarantined: quarantined.some(path => prefix(change.path, path)) });
    }
    return [...folded.values()].map(item => {
      let reason: string | null = null;
      if (!reversibleJournalPath(item.path)) reason = "non_reversible_metadata";
      else if (details.missing.some(missing => prefix(item.path, missing.path))) reason = "incomplete_observation";
      else if ([item.before, item.after].some(version => version && (version.ignored || version.kind === "other" || version.kind === "file" && !version.hash))) reason = "version_unavailable";
      else if (action === "restore" && (!item.quarantined || !item.after)) reason = "not_quarantined";
      else if (action === "revert" && item.quarantined) reason = "quarantined_use_restore";
      else if (same(item.before, item.after)) reason = "no_net_change";
      return { ...item, ...(action === "restore" ? { before: item.after, after: null } : {}), state: reason ? "excluded" : "eligible", reason };
    });
  }
  function resolveSelection(sessionId: string, turnId: string, request: TurnRevertRequest): Selected[] {
    if (!request.path || !request.version || !request.expected) throw new RevertUnavailable("Explicit reviewed conflict versions are required.");
    const details=journal.details(sessionId,turnId), item=select(sessionId,turnId,"revert").find(item=>item.path===request.path);
    if (!details || !item || item.state!=="eligible" && item.reason!=="no_net_change") throw new RevertUnavailable("Retained conflict versions are unavailable.");
    const changes=details.changes.filter(change=>change.path===request.path), latest=changes.at(-1), conflict=latest?.conflict;
    const equal=(a:JournalObservationReference,b:JournalObservationReference)=>a.turnId===b.turnId&&a.sequence===b.sequence&&a.side===b.side;
    if (!conflict || !equal(request.expected,conflict.latest)) throw new RevertUnavailable("The reviewed latest observation is no longer current.");
    function selected(ref:JournalObservationReference): JournalVersion|null {
      if (!conflict!.versions.some(candidate=>equal(candidate,ref))) throw new RevertUnavailable("Selected observation does not belong to this conflict.");
      const change=changes.find(change=>change.sequence===ref.sequence&&ref.turnId===turnId&&ref.side==="after");
      if (!change) throw new RevertUnavailable("Selected observation is unavailable.");
      const version=change.after;
      if(version&&(version.ignored||version.kind==="other"||version.kind==="file"&&!version.hash)) throw new RevertUnavailable("Selected raw version is unavailable.");
      return version;
    }
    const desired=selected(request.version);
    let other:JournalVersion|null= null;
    if(request.action==="keep_both") {
      if(!request.otherVersion)throw new RevertUnavailable("Two explicit versions are required.");
      other=selected(request.otherVersion);
      if(!desired||!other||desired.kind!=="file"||other.kind!=="file"||same(desired,other))throw new RevertUnavailable("Keep both requires two distinct retained regular-file versions.");
    } else if(request.otherVersion) throw new RevertUnavailable("Unexpected second version.");
    return [{...item,before:desired,after:latest!.after,beforeSequence:request.version.sequence,afterSequence:request.expected.sequence,state:"eligible",reason:null,...(other?{other,otherSequence:request.otherVersion!.sequence}:{})}];
  }
  const publicPath = (path: Selected): TurnRevertPath => ({ path: path.path, state: path.state, reason: path.reason, quarantined: path.quarantined });
  function operation(id: string, principalId: string, sessionId: string, sourceTurnId: string): Operation | null {
    const row = db.query("SELECT * FROM turn_journal_revert_operations WHERE id=? AND principal_id=? AND session_id=? AND source_turn_id=?").get(id, principalId, sessionId, sourceTurnId) as Operation | null;
    if (row && ["waiting", "applying"].includes(row.state) && !processAlive(row.pid, row.pid_start)) {
      journal.writeOperation(() => db.query("UPDATE turn_journal_revert_operations SET state=?,completed_at=?,error=? WHERE id=?").run(row.state === "waiting" ? "failed" : "unknown", Date.now(), row.state === "waiting" ? "interrupted_before_write" : "interrupted_partial_work", id));
      row.error = row.state === "waiting" ? "interrupted_before_write" : "interrupted_partial_work"; row.state = row.state === "waiting" ? "failed" : "unknown";
    }
    return row;
  }
  function receipt(id: string, principalId: string, sessionId: string, sourceTurnId: string): TurnRevertReceipt | null {
    const row = operation(id, principalId, sessionId, sourceTurnId); if (!row) return null;
    const paths = db.query("SELECT path,state,code FROM turn_journal_revert_paths WHERE operation_id=? ORDER BY path").all(id) as {path:string;state:TurnRevertPath["state"];code:string}[];
    let undoAvailable = false;
    if (["complete", "partial"].includes(row.state)) { try { undoAvailable = select(sessionId,row.journal_turn_id,"revert").some(path=>path.state === "eligible"); } catch { /* Missing detail never offers Undo. */ } }
    return { ...(row.selection && row.selection !== "{}" ? {resolution:JSON.parse(row.selection) as ConflictVersionSelection}:{}), undoAvailable, id: row.id, sourceTurnId: row.source_turn_id, journalTurnId: row.journal_turn_id, state: row.state, action: row.action,
      error: row.error.trim() || null, paths: paths.map(item => ({path:item.path,state:item.state,reason:item.code.trim() || null,quarantined:row.action === "restore"})) };
  }
  async function execute(row: Operation, selected: Selected[]) {
    let observed = false, hold: Awaited<ReturnType<WriterGate["acquire"]>> | undefined;
    try {
      hold = await options.gate.acquire("exclusive", `revert:${row.id}`, { queueTurns: true, signal: shutdown.signal });
      await options.lock.withLock(BRAIN_LOCK_KEY, () => options.lock.withLock(GIT_LOCK_KEY, async () => {
        if (!options.isAuthorized(row.principal_id)) throw new RevertUnavailable("authorization_changed");
        let observationFailure: Error | undefined;
        const source = journal.summary(row.journal_turn_id);
        await journal.begin(row.journal_turn_id, { sessionId: row.session_id, actor: "user", model: null, profile: source.profile ?? "strict", policyHash: source.policyHash, coveredPaths: selected.map(item => item.path) }, error => { observationFailure = error; });
        observed = true;
        journal.writeOperation(() => db.query("UPDATE turn_journal_revert_operations SET state='applying' WHERE id=?").run(row.id));
        for (const path of selected) {
          if (path.state !== "eligible") continue;
          if (observationFailure || !options.isAuthorized(row.principal_id)) throw observationFailure ?? new RevertUnavailable("authorization_changed");
          let state: TurnRevertPath["state"], code = "";
          try {
            state = journal.withRetainedVersion(path.before, copy => restoreJournalPath(options.brainPath, path.path, path.after, path.before, copy));
            code = state === "conflict" ? "changed_since_observation" : "";
          } catch { state = "failed"; code = "restoration_unavailable"; }
          journal.writeOperation(() => db.query("UPDATE turn_journal_revert_paths SET state=?,code=? WHERE operation_id=? AND path=?").run(state, code.padEnd(64), row.id, path.path));
          path.state = state; path.reason = code || null;
          await journal.observe();
          if(state === "restored" && path.other) {
            let sibling:Selected|undefined;
            try {
              journal.withRetainedVersion(path.other, copy=>createJournalSibling(options.brainPath,path.path,path.other!,copy,
                candidate=>{
                  sibling={path:candidate,before:path.other!,after:null,beforeSequence:path.otherSequence!,afterSequence:0,state:"eligible",reason:null,quarantined:false};
                  journal.writeOperation(()=>db.query("INSERT INTO turn_journal_revert_paths (operation_id,path,before_json,after_json,before_sequence,after_sequence,state,code) VALUES (?,?,?,NULL,?,0,'eligible',?)").run(row.id,candidate,JSON.stringify(path.other),path.otherSequence!,"".padEnd(64)));
                  journal.coverPaths(row.journal_turn_id,[candidate]);
                }, candidate=>{journal.writeOperation(()=>db.query("DELETE FROM turn_journal_revert_paths WHERE operation_id=? AND path=?").run(row.id,candidate));sibling=undefined;}));
              sibling!.state="restored";
            } catch { if(sibling){sibling.state="failed";sibling.reason="sibling_creation_unavailable";}else{path.state="failed";path.reason="sibling_creation_unavailable";journal.writeOperation(()=>db.query("UPDATE turn_journal_revert_paths SET state='failed',code=? WHERE operation_id=? AND path=?").run("sibling_creation_unavailable".padEnd(64),row.id,path.path));} }
            if(sibling){selected.push(sibling);journal.writeOperation(()=>db.query("UPDATE turn_journal_revert_paths SET state=?,code=? WHERE operation_id=? AND path=?").run(sibling!.state,(sibling!.reason??"").padEnd(64),row.id,sibling!.path));}
            await journal.observe();
          }
        }
        const conflicts = selected.filter(path => path.state === "conflict");
        for (let offset = 0; offset < conflicts.length; offset += 1) recordGovernanceEvent(db, {kind:"revert_conflict",sessionId:row.session_id,turnId:row.journal_turn_id,actor:"user",model:null,profile:source.profile,
          payload:{conflicts:conflicts.slice(offset,offset+1).map(path=>({path:path.path,state:"changed"})),restored:selected.filter(path=>path.state==="restored").length}});
      }));
      await journal.finish(row.journal_turn_id);
      const partial = selected.some(path => ["conflict", "failed", "excluded"].includes(path.state)) || journal.summary(row.journal_turn_id).state !== "complete";
      journal.writeOperation(() => db.query("UPDATE turn_journal_revert_operations SET state=?,completed_at=?,error=trim(error) WHERE id=?").run(partial ? "partial" : "complete", Date.now(), row.id));
    } catch (error) {
      const reason = (error as {reason?:string}).reason === "journal_capacity" ? "journal_capacity" : (error as {reason?:string}).reason === "journal_storage_unavailable" ? "journal_unavailable" : error instanceof RevertUnavailable ? "authorization_changed" : "operation_unavailable";
      try { if (observed) await journal.finish(row.journal_turn_id); else journal.finishReserved(row.journal_turn_id); } catch { /* An interrupted journal remains partial, never undoable by assumption. */ }
      try { journal.writeOperation(() => db.query("UPDATE turn_journal_revert_operations SET state=?,completed_at=?,error=? WHERE id=?").run(observed ? "unknown" : "failed", Date.now(), reason, row.id)); } catch { /* Readback will retain the original pending identity. */ }
    } finally { hold?.release(); if (selected.some(path => path.state === "restored" || path.state === "failed")) { try { options.refresh(); } catch { /* The ordinary index refresh may be retried; file effects remain recorded. */ } } }
  }
  return {
    plan(sessionId: string, turnId: string, action: "revert" | "restore" = "revert"): TurnRevertPlan { return { turnId, action, paths: select(sessionId, turnId, action).map(publicPath) }; },
    start(principalId: string, sessionId: string, sourceTurnId: string, request: TurnRevertRequest): TurnRevertReceipt {
      if (shutdown.signal.aborted || !options.isAuthorized(principalId)) throw new RevertUnavailable("A current user authorization is required.");
      if (!/^[a-zA-Z0-9_-]{16,96}$/.test(request.id)) throw new RevertUnavailable("Invalid operation identity.");
      const action = request.action ?? "revert";
      if(!["revert","restore","keep_version","keep_both"].includes(action))throw new RevertUnavailable("Invalid history action.");
      if(["revert","restore"].includes(action)&&(request.version||request.expected||request.otherVersion))throw new RevertUnavailable("Unexpected conflict selection.");
      const selection:ConflictVersionSelection|undefined = ["keep_version","keep_both"].includes(action) ? {path:request.path!,version:request.version!&&{turnId:request.version.turnId,sequence:request.version.sequence,side:request.version.side},expected:request.expected!&&{turnId:request.expected.turnId,sequence:request.expected.sequence,side:request.expected.side},...(request.otherVersion?{otherVersion:{turnId:request.otherVersion.turnId,sequence:request.otherVersion.sequence,side:request.otherVersion.side}}:{})}:undefined;
      const fingerprint = createHash("sha256").update(JSON.stringify({sessionId,sourceTurnId,path:request.path ?? null,action,...(selection?{selection}:{})})).digest("hex");
      const existing = db.query("SELECT * FROM turn_journal_revert_operations WHERE id=?").get(request.id) as Operation | null;
      if (existing) {
        if (existing.principal_id !== principalId || existing.session_id !== sessionId || existing.source_turn_id !== sourceTurnId || existing.fingerprint !== fingerprint) throw new RevertUnavailable("Operation identity belongs to another request.");
        return receipt(request.id,principalId,sessionId,sourceTurnId)!;
      }
      const all = selection ? resolveSelection(sessionId,sourceTurnId,request) : select(sessionId,sourceTurnId,action as "revert"|"restore"), selected = request.path !== undefined ? all.filter(item=>item.path===request.path) : all;
      if (!selected.some(item=>item.state==="eligible")) throw new RevertUnavailable("No retained eligible paths are available.");
      const journalTurnId = `revert_${request.id}`;
      journal.reserveRevert(journalTurnId,sourceTurnId,selected.flatMap(item=>[item.before,item.after,...(item.other?[item.other]:[])]));
      try { journal.writeOperation(() => {
        db.query("INSERT INTO turn_journal_revert_operations (id,principal_id,session_id,source_turn_id,journal_turn_id,fingerprint,action,state,pid,pid_start,requested_at,error,selection) VALUES (?,?,?,?,?,?,?,'waiting',?,?,?,?,?)")
          .run(request.id,principalId,sessionId,sourceTurnId,journalTurnId,fingerprint,action,SELF.pid,SELF.start,Date.now(),"".padEnd(64),JSON.stringify(selection??{}));
        for (const item of selected) db.query("INSERT INTO turn_journal_revert_paths (operation_id,path,before_json,after_json,before_sequence,after_sequence,state,code) VALUES (?,?,?,?,?,?,?,?)")
          .run(request.id,item.path,item.before ? JSON.stringify(item.before) : null,item.after ? JSON.stringify(item.after) : null,item.beforeSequence,item.afterSequence,item.state,(item.reason ?? "").padEnd(64));
      }); } catch (error) { journal.finishReserved(journalTurnId); throw error; }
      const row = operation(request.id,principalId,sessionId,sourceTurnId)!;
      const work = execute(row,selected).finally(()=>running.delete(request.id)); running.set(request.id,work);
      return receipt(request.id,principalId,sessionId,sourceTurnId)!;
    },
    receipt,
    latest(principalId: string, sessionId: string, sourceTurnId: string) {
      const row = db.query("SELECT id FROM turn_journal_revert_operations WHERE principal_id=? AND session_id=? AND source_turn_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1").get(principalId,sessionId,sourceTurnId) as {id:string} | null;
      return row ? receipt(row.id,principalId,sessionId,sourceTurnId) : null;
    },
    async idle(id: string) { await running.get(id); },
    async close() { shutdown.abort(new Error("server_shutdown")); await Promise.all(running.values()); },
  };
}
export type TurnReverts = ReturnType<typeof createTurnReverts>;
