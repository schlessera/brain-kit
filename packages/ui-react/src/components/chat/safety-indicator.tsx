import type { SafetyFuturePrepared } from "@schlessera/brain-ui-sdk/protocol";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { Button, Icon, IconButton } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { activeChat, useChatStore, type ToolCall } from "../../stores/chat-store.js";
import { READING_COLUMN_ATTR } from "../../lib/client-environment.js";
import { entryEvidence, safetyEvidence, type SafetyEvidence } from "../../lib/safety-evidence.js";
import { createSafetyReviewer, type SafetyReviewProgress } from "../../lib/safety-reviewer.js";

const formatAuthority = ({host,port}:{host:string;port:number}) => `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;

const sources:Record<SafetyEvidence["occurrence"]["source"],string>={web_fetch:"Web fetch",web_search:"Web search",staged_share:"Shared input",chat_attachment:"Chat attachment",
  workspace_read:"Workspace read",mcp_document:"External tool input",user_marked:"Marked untrusted",fetching_command:"Fetching command",unclassified_command:"Unclassified command",
  compute_output:"Compute output",apify_result:"Apify result",github_result:"GitHub result",egress_connection:"Network input",legacy_unknown:"Input with an unknown source"};

/** The host's tool identity AND turn identity must match the rendered entry. */
export function ToolSafetyIndicator({turnId,toolCalls}:{turnId?:string;toolCalls:readonly ToolCall[]}) {
  const root=useBrainUiRoot(),records=useStore(root.stores.safety,s=>s.records);
  const entries=useMemo(()=>entryEvidence(records,turnId,toolCalls.map(tool=>tool.id)),[records,turnId,toolCalls]);
  return <SafetyIndicator entries={entries} toolCalls={toolCalls} turnId={turnId}/>;
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
  const text=normal?"Normal policy restored":p?`${state.status==="ready"?"Still restricted":"Evidence unavailable · last read"} · ${p.unresolvedCount} unresolved input${p.unresolvedCount===1?"":"s"}`:"Safety evidence unavailable";
  return <aside data-session-safety className="mb-3 min-w-0 space-y-1 text-xs text-muted-foreground" aria-label="Chat safety evidence">
    <p className="flex min-h-8 items-center gap-2 leading-4"><Icon icon={normal?"secure":state.status!=="ready"||unknown?"unverified":"policy"} size={16}/><span role="status">{text}</span></p>
    {unknown&&p&&state.status==="ready"&&<p>Earlier inputs were not fully recorded. Reviewing known inputs cannot restore normal policy. <NewChatGuidance/></p>}
    {auth==="active"&&state.supported&&state.status==="unavailable"&&state.reason!=="unauthorized"&&state.reason!=="retired"&&state.reason!=="disconnected"&&<Button label="Refresh safety evidence" tone="quiet" reach onClick={state.refresh}/>}
    {!!p?.pendingCount&&<p>Input is being recorded; new actions remain restricted.</p>}
    {p?.reasons.includes("recording_failed")&&<p>Recording is unavailable. Restrictions remain in effect.</p>}
    <details><summary className="min-h-11 cursor-pointer py-3">What this evidence covers</summary><p>Coverage describes the host's supported detectors. It does not verify content safety. Proxied shell local reads and opaque transport may have no tool attribution.</p></details>
    {shownGroups.slice(0,shown).map(([turn,entries])=><div key={turn} data-safety-turn-event={turn} className="flex min-w-0 items-center gap-2">
      <SafetyIndicator entries={entries}/><span>Turn event · {entries.some(e=>e.occurrence.source==="egress_connection")?"Network input · The proxy could not identify the tool that opened the connection.":"Input safety evidence"}</span>
    </div>)}
    {shownGroups.length>shown&&<Button label={`Show more safety events (${shownGroups.length-shown} remaining)`} tone="quiet" reach onClick={()=>setShown(n=>n+25)}/>}
  </aside>;
}

function NewChatGuidance() {
  const wide=useMediaQuery("(min-width: 1280px)");
  return <>To start with a separate history, use {wide?"New conversation in Sessions":"New chat in the chat header"}.</>;
}

function SafetyIndicator({entries:currentEntries,toolCalls,turnId}:{entries:SafetyEvidence[];toolCalls?:readonly ToolCall[];turnId?:string}) {
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
  const unresolvedEntries=entries.filter(e=>e.exposure!=="not_delivered"&&!e.decision&&!e.occurrence.admission?.trusted);
  const unresolved=unresolvedEntries.length,unknown=entries.some(e=>e.occurrence.detailPruned||e.occurrence.source==="legacy_unknown");
  const trusted=entries.filter(e=>e.occurrence.admission?.trusted).length,reviewed=entries.filter(e=>e.decision).length;
  const refused=entries.filter(e=>e.exposure==="not_delivered").length;
  const accepted=[...(refused?[`${refused} refused before delivery`]:[]),...(trusted?[`${trusted} trusted at admission`]:[]),...(reviewed?[`${reviewed} marked safe by you`]:[])].join("; ");
  const name=unresolved?`Safety restrictions · ${entries.length===1?"This input":"This group"} · ${unresolved} unresolved input${unresolved===1?"":"s"}${accepted?`; ${accepted}`:""}`
    :trusted===entries.length&&!reviewed?`Trusted at admission${entries.length>1?`: ${entries.length} inputs`:""}: show details`
    :reviewed===entries.length&&!trusted?`Marked safe by you${entries.length>1?`: ${entries.length} inputs`:""}: show details`
    :`Safety history: ${accepted}: show details`;
  const reason=unresolved?`${sources[unresolvedEntries[0]!.occurrence.source]} · Review one input at a time`
    :refused===entries.length?"The host refused this fetch before it ran":trusted&&reviewed?"Historical source trust and human decisions retained; current rules may differ"
    :trusted?"Historical source trust retained; current rules may differ":"Human decision retained; content remains in the model context";
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
  function nextIndicator() {
    const current = trigger.current;
    const column = current?.closest(`[${READING_COLUMN_ATTR}]`);
    if (!current || !column) return null;
    const buttons = [...column.querySelectorAll<HTMLButtonElement>("[data-safety-indicator] > button")]
      .filter(button => button.getClientRects().length > 0);
    const index = buttons.indexOf(current);
    return [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)]
      .find(button => button.parentElement?.dataset.unresolved === "true");
  }
  function showNext() {
    const target = nextIndicator();
    if (!target) return;
    setOpen(false);
    target.focus();
    target.scrollIntoView({block:"nearest"});
  }
  if(!entries.length||auth!=="active")return null;
  return <span data-safety-indicator data-unresolved={unresolved>0} className="group relative inline-flex shrink-0 items-center">
    <IconButton ref={trigger} name={`${name}; ${reason}`} icon={unresolved?unknown?"unverified":"policy":"secure"} expanded={open} controls={id} haspopup="dialog"
      style={{minWidth:44,minHeight:44}} onClick={()=>setOpen(v=>!v)}/>
    {entries.length>1&&<span className="pointer-events-none absolute right-0 top-0 font-mono text-[10px]" aria-hidden="true">{unresolved||entries.length}</span>}
    {!open&&<span role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-popover w-max max-w-56 rounded border border-border bg-surface p-2 text-xs text-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">{reason}</span>}
    {open&&createPortal(<div ref={panel} id={id} role="dialog" aria-label="Safety input details" data-safety-details className="fixed z-popover min-w-0 overflow-auto rounded-lg border border-border bg-surface p-3 text-sm text-foreground shadow-lg"
      style={{...position,width:"min(384px, calc(100vw - 24px))",maxHeight:"min(65vh, 520px)",overflowWrap:"anywhere"}}>
      <div className="flex items-center justify-between gap-2"><strong>{name}</strong><IconButton icon="dismiss" name="Close safety details" style={{minWidth:44,minHeight:44}} onClick={close}/></div>
      <p className="mb-3 text-xs">Marking an input safe accepts that input for this chat. Its contents stay in the model’s context.</p>
      {entries.slice(0,limit).map(entry=><SafetyTrigger key={entry.occurrence.id} entry={entry} nextIndicator={nextIndicator} showNext={showNext} toolName={entry.occurrence.turnId===turnId ? toolCalls?.find(tool=>tool.id===entry.occurrence.entry?.toolUseId)?.name : undefined}/>)}
      {entries.length>limit&&<Button label="Show more inputs" tone="quiet" reach onClick={()=>setLimit(n=>n+20)}/>}
    </div>,document.body)}
  </span>;
}

function SafetyTrigger({entry,toolName,nextIndicator,showNext}:{entry:SafetyEvidence;toolName?:string;nextIndicator:()=>HTMLButtonElement|null|undefined;showNext:()=>void}) {
  const root=useBrainUiRoot(),state=useStore(root.stores.safety),auth=useStore(root.authLock.state,s=>s.phase);
  const [savedRule,setSavedRule]=useState<string|null>(null);
  const [future,setFuture]=useState(false),[recipient,setRecipient]=useState(false),[prepared,setPrepared]=useState<SafetyFuturePrepared|null>(null);
  const [review,setReview]=useState(false),[progress,setProgress]=useState<SafetyReviewProgress|null>(null);
  const reviewer=useRef<ReturnType<typeof createSafetyReviewer>|null>(null);
  useEffect(()=>{const r=createSafetyReviewer(root,setProgress);reviewer.current=r;return ()=>{r.dispose();reviewer.current=null;};},[root]);
  useEffect(()=>{if(state.status!=="ready"||!state.capabilities?.review||auth!=="active")setReview(false);},[state.status,state.capabilities?.review,auth]);
  useEffect(()=>{if(auth!=="active"){setPrepared(null);setProgress(null);setReview(false);}},[auth]);
  const r=entry.occurrence,session=state.identity&&"sessionId" in state.identity?state.identity:null;
  const readable=state.status==="ready"&&!!session,owner=state.capabilities?.review===true&&auth==="active";
  const sessionKey=JSON.stringify(session);
  useEffect(()=>{
    if(!readable||!owner||!state.capabilities?.originRules||!session){setSavedRule(null);return;}
    const controller=new AbortController();let sequence=0;
    const read=()=>{
      const request=++sequence;
      void root.api.safetyFutureStatus({version:1,session,occurrenceId:r.id},controller.signal).then(result=>{
        if(controller.signal.aborted||request!==sequence)return;
        if(!result){setSavedRule(null);return;}
        if(result.occurrenceId!==r.id||JSON.stringify(result.session)!==sessionKey)throw new Error("Different future review status");
        const presence=result.rule.currentRule;
        setSavedRule(`${result.stage==="prepared"?"Future rule prepared but not published; fresh review is required. ":result.stage==="partial"?"Rule publication proved; this operation's verdict is incomplete. ":result.stage==="unknown"?"Rule publication is unknown; fresh review is required. ":""}Future rule: ${presence}.`);
      }).catch(()=>{if(!controller.signal.aborted&&request===sequence)setSavedRule("Could not verify future rule publication or current presence. Refresh evidence to try again.");});
    };
    read();window.addEventListener("focus",read);
    return()=>{controller.abort();window.removeEventListener("focus",read);};
  },[root,r.id,sessionKey,readable,owner,state.capabilities?.originRules,state.revision]);
  const canReview=readable&&owner&&entry.exposure==="finalized"&&!entry.decision&&!r.admission?.trusted&&!state.projection?.pendingCount&&!state.projection?.reasons.includes("recording_failed");
  const futureAvailable=state.capabilities?.originRules===true&&r.detector==="proxy_input"&&!!r.provenance;
  const busy=progress?.stage==="pending",unknown=progress?.stage==="unknown";
  const provenance=r.provenance?.kind==="web_origin"?`${r.provenance.origin.scheme}://${formatAuthority(r.provenance.origin)}`:
    r.provenance?.kind==="tunnel_authority"?formatAuthority(r.provenance.authority):"Source provenance unavailable";
  const noDelivery=entry.exposure==="not_delivered";
  const counted=!noDelivery&&!entry.decision&&!r.admission?.trusted;
  const ended=state.projection?.coverage.epochs.some(epoch=>epoch.id===r.epochId&&epoch.endSequence!==null);
  const arriving=entry.exposure==="open"&&!ended;
  const statusLine=useRef<HTMLParagraphElement>(null);
  const [hasNext,setHasNext]=useState(false);
  const committed=progress?.stage==="committed" && !!entry.decision && readable;
  const focused=useRef(false);
  useLayoutEffect(()=>{
    setHasNext(committed && !!state.projection?.unresolvedCount && !!nextIndicator());
    if(committed && !focused.current) {
      focused.current=true;
      statusLine.current?.focus();
    }
  },[committed,state.projection,nextIndicator]);
  return <section data-safety-trigger={r.id} className="space-y-2 border-t border-border py-3">
    <p className="font-medium">{noDelivery?"Fetch refused before delivery":r.admission?.trusted?"Trusted at admission":entry.decision?"Marked safe by you":"Safety restrictions enabled"}</p>
    <p>Observed · {r.detector==="tool_search_output"?"Local search result":sources[r.source]} · <time dateTime={new Date(r.observedAt).toISOString()}>{new Date(r.observedAt).toLocaleString()}</time></p>
    {toolName&&<p>Action · {["Grep","grep","Glob"].includes(toolName)?`Local search (${toolName})`:toolName}</p>}
    {r.provenance&&<p>Destination · {provenance}</p>}
    {r.source==="egress_connection"&&!toolName&&<p>The proxy saw this connection. It could not identify which tool opened it.</p>}
    {noDelivery&&<p>The fetch never ran. This attempt stays in history and needs no review.</p>}
    {!noDelivery&&!r.provenance&&<p>{r.detector==="tool_search_output"?"The host could not identify the source of every returned match.":"The host did not record a verified origin for this input."}</p>}
    {savedRule&&<p role="status">{savedRule}</p>}
    {r.admission?.trusted&&<p>Source rule {r.admission.ruleId} · trust revision {r.admission.trustRevision}. This historical decision grants no current recipient permission.</p>}
    {r.detailPruned&&<p>Some source detail has expired. The input and any decision remain recorded.</p>}
    {entry.decision&&<p>Marked safe by you · <time dateTime={new Date(entry.decision.observedAt).toISOString()}>{new Date(entry.decision.observedAt).toLocaleString()}</time></p>}
    {counted&&entry.exposure!=="finalized"&&<p>{arriving?"Input is still arriving. Mark as safe is unavailable until delivery is finalized.":"Delivery could not be confirmed. This input cannot be marked safe."} {!arriving&&<NewChatGuidance/>}</p>}
    {counted&&!owner&&<p>Only the authenticated owner can mark this input safe.</p>}
    {!readable&&<div><p>Current evidence is unavailable or incomplete.</p><Button label="Refresh safety evidence" reach tone="quiet" onClick={state.refresh}/></div>}
    {readable&&owner&&!r.admission?.trusted&&!entry.decision&&entry.exposure==="finalized"&&(
      state.projection?.reasons.includes("recording_failed")?<p>Recording failed. This chat stays restricted. <NewChatGuidance/></p>
      :state.projection?.pendingCount?<p>Input is still being recorded. Review will be available when recording finishes.</p>:null)}
    {canReview&&state.projection&&<p>Marking this input safe leaves {Math.max(0,state.projection.unresolvedCount-1)} other unresolved {state.projection.unresolvedCount===2?"input":"inputs"}. By itself, this decision grants no future trust or permission to send data.</p>}
    {canReview&&!review&&!progress&&<Button label="Mark as safe" reach onClick={()=>{setReview(true);setFuture(false);setRecipient(false);setPrepared(null);}}/>}
    {review&&canReview&&!progress&&<div className="space-y-2" role="group" aria-label="Review safety decision">
      <label className="flex min-h-11 items-center gap-2"><input type="radio" name={`scope-${r.id}`} checked={!future} onChange={()=>setFuture(false)}/> Only this input</label>
      {futureAvailable&&<label className="flex min-h-11 items-center gap-2"><input type="radio" name={`scope-${r.id}`} checked={future} onChange={()=>setFuture(true)}/> Also trust future input from {provenance}</label>}
      {future&&<><p>Trust incoming content from {provenance} for future input. Resolve only this input. Other recorded inputs keep their existing verdicts.</p>
        {state.capabilities?.recipientRules&&<label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={recipient} onChange={e=>setRecipient(e.target.checked)}/> Allow sending data while restricted</label>}</>}
      <p>Keep the original event and record your safe verdict for this input. Other verdicts and coverage remain unchanged.</p>
      <Button label={future?"Review future rule":"Mark this input as safe"} reach onClick={()=>{if(future)void reviewer.current?.prepareFuture(r.id,recipient).then(p=>setPrepared(p??null));else void reviewer.current?.markSafe(r.id);}}/>
      <Button label="Cancel safety review" tone="quiet" reach onClick={()=>setReview(false)}/>
    </div>}
    {prepared&&progress?.stage==="review"&&canReview&&<div role="group" aria-label="Exact future rule review"><p>Exact target: {provenance}. Other verdicts remain unchanged. Recipient permission: {recipient?"allow sending data while restricted":"off"}.</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{prepared.review.diff}</pre><Button label={recipient?"Save rule, allow sending while restricted, and mark this input safe":"Save future source rule and mark this input safe"} reach onClick={()=>void reviewer.current?.commitFuture()}/><Button label="Cancel future rule review" tone="quiet" reach onClick={()=>{reviewer.current?.cancelFuture();setPrepared(null);setProgress(null);setReview(false);}}/></div>}
    {progress&&<p role="status">{progress.message}</p>}
    {(unknown||progress?.stage==="refused"||progress?.stage==="partial")&&!busy&&<Button label="Refresh safety evidence" tone="quiet" reach onClick={()=>{setProgress(null);setReview(false);state.refresh();}}/>}
    <p className="text-xs" role="status" ref={statusLine} tabIndex={-1}>{readable&&state.projection
      ? `Whole chat · ${state.projection.unresolvedCount} unresolved input${state.projection.unresolvedCount===1?"":"s"}${counted?", including this one":" · this input is not counted"} · ${state.normal&&state.projection.restriction==="normal"&&state.projection.coverage.state==="complete"&&!state.projection.pendingCount&&!state.projection.unresolvedCount?"Normal policy restored":"Still restricted"}`
      :"Whole chat · current evidence unavailable"}</p>
    {hasNext&&<Button label="Show next unresolved input" tone="quiet" reach onClick={showNext}/>}
  </section>;
}
