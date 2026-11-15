import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { Button, Icon, IconButton } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { activeChat, useChatStore } from "../../stores/chat-store.js";
import { entryEvidence, safetyEvidence, type SafetyEvidence } from "../../lib/safety-evidence.js";
import { createSafetyReviewer, type SafetyReviewProgress } from "../../lib/safety-reviewer.js";

const sources:Record<SafetyEvidence["occurrence"]["source"],string>={web_fetch:"Web fetch",web_search:"Web search",staged_share:"Shared input",chat_attachment:"Chat attachment",
  workspace_read:"Workspace read",mcp_document:"External tool input",user_marked:"Marked untrusted",fetching_command:"Fetching command",unclassified_command:"Unclassified command",
  compute_output:"Compute output",apify_result:"Apify result",egress_connection:"Network input",legacy_unknown:"Legacy input evidence"};

/** The host's tool identity AND turn identity must match the rendered entry. */
export function ToolSafetyIndicator({turnId,toolIds}:{turnId?:string;toolIds:readonly string[]}) {
  const root=useBrainUiRoot(),records=useStore(root.stores.safety,s=>s.records);
  const entries=useMemo(()=>entryEvidence(records,turnId,toolIds),[records,turnId,toolIds]);
  return <SafetyIndicator entries={entries}/>;
}

/** Kept outside message text, including events with no provable entry join. */
export function SessionSafety() {
  const root=useBrainUiRoot(),state=useStore(root.stores.safety),messages=useChatStore(s=>activeChat(s).messages);
  const sessionId=useChatStore(s=>s.activeSessionId),auth=useStore(root.authLock.state,s=>s.phase);
  const retained=useRef<{scope:string;groups:Array<[string,SafetyEvidence[]]>;projection:typeof state.projection}>({scope:"",groups:[],projection:null});
  const [shown,setShown]=useState(25);
  const groups=useMemo(()=>{
    const visible=new Set<string>();
    for(const message of messages){const turn=message.turnId??message.streamTurnId;if(turn)for(const tool of message.toolCalls)visible.add(`${turn}\0${tool.id}`);}
    const result=new Map<string,SafetyEvidence[]>();
    for(const entry of safetyEvidence(state.records).values()){
      const r=entry.occurrence;
      if(r.entry&&visible.has(`${r.turnId}\0${r.entry.toolUseId}`))continue;
      const key=r.turnId,list=result.get(key)??[];list.push(entry);result.set(key,list);
    }
    return [...result];
  },[messages,state.records]);
  const scope=`${sessionId}\0${root.authLock.epoch()}\0${state.historyScopeKey}`;
  const allowed=auth==="active"&&state.supported&&(state.status!=="unavailable"||state.reason==="disconnected");
  if(retained.current.scope!==scope||!allowed)retained.current={scope,groups:[],projection:null};
  if(allowed){if(groups.length||state.status==="ready")retained.current.groups=groups;if(state.projection)retained.current.projection=state.projection;}
  const shownGroups=allowed?retained.current.groups:[];
  const p=allowed?(state.projection??retained.current.projection):null;
  const normal=allowed&&state.status==="ready"&&state.normal&&p?.coverage.state==="complete"&&p.unresolvedCount===0&&p.pendingCount===0&&p.restriction==="normal";
  const unknown=p?.coverage.state!=="complete";
  const text=normal?"Normal policy restored":p?`${state.status==="ready"?"Still restricted":"Evidence unavailable · last read"} · ${p.unresolvedCount} unresolved trigger${p.unresolvedCount===1?"":"s"}`:"Safety evidence unavailable";
  return <aside data-session-safety className="mb-3 min-w-0 space-y-1 text-xs text-muted-foreground" aria-label="Chat safety evidence">
    <p className="flex min-h-8 items-center gap-2 leading-4"><Icon icon={normal?"secure":state.status!=="ready"||unknown?"unverified":"policy"} size={16}/><span role="status">{text}</span></p>
    {unknown&&<p>Coverage is incomplete or unavailable. Reviewing known triggers cannot establish complete history.</p>}
    {!!p?.pendingCount&&<p>Input is being recorded; new actions remain restricted.</p>}
    {p?.reasons.includes("recording_failed")&&<p>Recording is unavailable. Restrictions remain in effect.</p>}
    <details><summary className="min-h-11 cursor-pointer py-3">What this evidence covers</summary><p>Coverage describes the host's supported detectors. It does not verify content safety. Proxied shell local reads and opaque transport may have no tool attribution.</p></details>
    {shownGroups.slice(0,shown).map(([turn,entries])=><div key={turn} data-safety-turn-event={turn} className="flex min-w-0 items-center gap-2">
      <SafetyIndicator entries={entries}/><span>Turn event · {entries.some(e=>e.occurrence.source==="egress_connection")?"Network input; tool attribution unavailable":"Input safety evidence"}</span>
    </div>)}
    {shownGroups.length>shown&&<Button label={`Show more safety events (${shownGroups.length-shown} remaining)`} tone="quiet" reach onClick={()=>setShown(n=>n+25)}/>}
  </aside>;
}

function SafetyIndicator({entries:currentEntries}:{entries:SafetyEvidence[]}) {
  const root=useBrainUiRoot(),sessionId=useChatStore(s=>s.activeSessionId),auth=useStore(root.authLock.state,s=>s.phase);
  const supported=useStore(root.stores.safety,s=>s.supported),readReason=useStore(root.stores.safety,s=>s.reason);
  const readStatus=useStore(root.stores.safety,s=>s.status),historyScopeKey=useStore(root.stores.safety,s=>s.historyScopeKey);
  const [open,setOpen]=useState(false),[limit,setLimit]=useState(20),[position,setPosition]=useState({left:12,top:12});
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),id=useId();
  const scope=`${sessionId}\0${root.authLock.epoch()}\0${historyScopeKey}`,held=useRef<{scope:string;entries:SafetyEvidence[]}>({scope,entries:[]});
  const allowed=auth==="active"&&supported&&(readStatus!=="unavailable"||readReason==="disconnected");
  if(held.current.scope!==scope||!allowed)held.current={scope,entries:[]};
  if(currentEntries.length&&allowed)held.current={scope,entries:currentEntries};
  const entries=allowed?(currentEntries.length?currentEntries:open||readStatus!=="ready"?held.current.entries:[]):[];
  useEffect(()=>{if(!allowed)setOpen(false);},[allowed]);
  useEffect(()=>{setOpen(false);},[scope,auth]);
  const unresolved=entries.filter(e=>!e.decision).length,unknown=entries.some(e=>e.occurrence.detailPruned||e.occurrence.source==="legacy_unknown");
  const name=unresolved?`Safety restrictions: ${unresolved} unresolved trigger${unresolved===1?"":"s"}`:`Marked safe by you${entries.length>1?`: ${entries.length} triggers`:""}: show details`;
  const reason=unresolved?`${sources[entries[0]!.occurrence.source]} · Only this trigger can be reviewed`:"Human decision retained; content remains in the model context";
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const r=trigger.current?.getBoundingClientRect();if(r)setPosition({left:Math.max(12,Math.min(r.left,innerWidth-Math.min(384,innerWidth-24)-12)),top:Math.max(12,Math.min(r.bottom+4,innerHeight-Math.min(520,innerHeight*.65)-12))});};
    place();panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close=()=>{setOpen(false);queueMicrotask(()=>{if(trigger.current?.isConnected)trigger.current.focus({preventScroll:true});});};
    const outside=(e:PointerEvent)=>{if(!panel.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))close();};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close();}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape,true);window.addEventListener("resize",place);window.addEventListener("scroll",place,true);
    return ()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape,true);window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);};
  },[open]);
  const close=()=>{setOpen(false);trigger.current?.focus({preventScroll:true});};
  if(!entries.length||auth!=="active")return null;
  return <span data-safety-indicator className="group relative inline-flex shrink-0 items-center">
    <IconButton ref={trigger} name={`${name}; ${reason}`} icon={unresolved?unknown?"unverified":"policy":"secure"} expanded={open} controls={id} haspopup="dialog"
      style={{minWidth:44,minHeight:44}} onClick={()=>setOpen(v=>!v)}/>
    {entries.length>1&&<span className="pointer-events-none absolute right-0 top-0 font-mono text-[10px]" aria-hidden="true">{unresolved||entries.length}</span>}
    {!open&&<span role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-popover w-max max-w-56 rounded border border-border bg-surface p-2 text-xs text-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">{reason}</span>}
    {open&&createPortal(<div ref={panel} id={id} role="dialog" aria-label="Safety trigger details" data-safety-details className="fixed z-popover min-w-0 overflow-auto rounded-lg border border-border bg-surface p-3 text-sm text-foreground shadow-lg"
      style={{...position,width:"min(384px, calc(100vw - 24px))",maxHeight:"min(65vh, 520px)",overflowWrap:"anywhere"}}>
      <div className="flex items-center justify-between gap-2"><strong>{name}</strong><IconButton icon="dismiss" name="Close safety details" style={{minWidth:44,minHeight:44}} onClick={close}/></div>
      <p className="mb-3 text-xs">A human verdict accepts this retained input. It does not verify malware safety or remove content from the model context.</p>
      {entries.slice(0,limit).map(entry=><SafetyTrigger key={entry.occurrence.id} entry={entry}/>)}
      {entries.length>limit&&<Button label="Show more triggers" tone="quiet" reach onClick={()=>setLimit(n=>n+20)}/>}
    </div>,document.body)}
  </span>;
}

function SafetyTrigger({entry}:{entry:SafetyEvidence}) {
  const root=useBrainUiRoot(),state=useStore(root.stores.safety),auth=useStore(root.authLock.state,s=>s.phase);
  const [review,setReview]=useState(false),[progress,setProgress]=useState<SafetyReviewProgress|null>(null);
  const reviewer=useRef<ReturnType<typeof createSafetyReviewer>|null>(null);
  useEffect(()=>{const r=createSafetyReviewer(root,setProgress);reviewer.current=r;return ()=>{r.dispose();reviewer.current=null;};},[root]);
  useEffect(()=>{if(state.status!=="ready"||!state.capabilities?.review||auth!=="active")setReview(false);},[state.status,state.capabilities?.review,auth]);
  const r=entry.occurrence,session=state.identity&&"sessionId" in state.identity?state.identity:null;
  const readable=state.status==="ready"&&!!session,owner=state.capabilities?.review===true&&auth==="active";
  const canReview=readable&&owner&&entry.exposure==="finalized"&&!entry.decision&&!state.projection?.pendingCount&&!state.projection?.reasons.includes("recording_failed");
  const busy=progress?.stage==="pending",unknown=progress?.stage==="unknown";
  const provenance=r.provenance?.kind==="web_origin"?`${r.provenance.origin.scheme}://${r.provenance.origin.host}:${r.provenance.origin.port}`:
    r.provenance?.kind==="tunnel_authority"?`${r.provenance.authority.host}:${r.provenance.authority.port}`:"Source provenance unavailable";
  return <section data-safety-trigger={r.id} className="space-y-2 border-t border-border py-3">
    <p className="font-medium">{entry.decision?"Marked safe by you":"Safety restrictions enabled"}</p>
    <p>{sources[r.source]} · <time dateTime={new Date(r.observedAt).toISOString()}>{new Date(r.observedAt).toLocaleString()}</time></p>
    <p>{r.summary}</p><p>{provenance}</p>
    {r.detailPruned&&<p>Some source detail has expired. The trigger and any decision remain recorded.</p>}
    {entry.decision&&<p>Marked safe by you · <time dateTime={new Date(entry.decision.observedAt).toISOString()}>{new Date(entry.decision.observedAt).toLocaleString()}</time></p>}
    {!entry.decision&&entry.exposure!=="finalized"&&<p>{entry.exposure==="open"?"Input is still arriving. Mark as safe is unavailable until delivery is finalized.":"Delivery could not be confirmed. This trigger cannot be marked safe."}</p>}
    {!owner&&!entry.decision&&<p>Only the authenticated owner can mark this trigger safe.</p>}
    {!readable&&<p>Current evidence is unavailable or incomplete. Read it again before reviewing.</p>}
    {canReview&&!review&&!progress&&<Button label="Mark as safe" reach onClick={()=>setReview(true)}/>}
    {review&&canReview&&!progress&&<div className="space-y-2" role="group" aria-label="Review safety decision">
      <strong>Only this trigger</strong><p>Keep the original event and record your safe verdict for this trigger. Other triggers and incomplete coverage remain restrictive.</p>
      <Button label="Mark this trigger as safe" reach onClick={()=>void reviewer.current?.markSafe(r.id)}/>
      <Button label="Cancel safety review" tone="quiet" reach onClick={()=>setReview(false)}/>
    </div>}
    {progress&&!(entry.decision&&state.status==="ready")&&<p role="status">{progress.message}</p>}
    {(unknown||progress?.stage==="refused")&&!busy&&<Button label="Refresh safety evidence" tone="quiet" reach onClick={()=>{setProgress(null);setReview(false);state.refresh();}}/>}
    <p className="text-xs">{state.normal&&state.status==="ready"?"Normal policy restored":`Still restricted${state.projection?` · ${state.projection.unresolvedCount} unresolved triggers`:" · current evidence unavailable"}`}</p>
  </section>;
}
