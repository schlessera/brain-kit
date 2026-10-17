export const calloutsSpec = {
 "schema_version": 1,
 "type": "architecture",
 "title": "Homecoming relay",
 "desc": "Odysseus prepares the homecoming to Ithaca on 2026-07-12.",
 "size": "fit",
 "nodes": [
  {
   "id": "hermes",
   "label": "Hermes",
   "at": [
    48,
    64
   ],
   "size": [
    160,
    64
   ],
   "tag": "INPUT",
   "role": "input"
  },
  {
   "id": "odysseus",
   "label": "Odysseus",
   "at": [
    320,
    64
   ],
   "size": [
    160,
    64
   ],
   "tag": "AGENT",
   "role": "focal"
  },
  {
   "id": "ledger",
   "label": "Voyage ledger",
   "at": [
    592,
    64
   ],
   "size": [
    160,
    64
   ],
   "tag": "STORE",
   "role": "store"
  }
 ],
 "edges": [
  {
   "to": "odysseus",
   "label": "WORD",
   "kind": "link",
   "from": "hermes"
  },
  {
   "to": "ledger",
   "label": "RECORD",
   "kind": "async",
   "from": "odysseus"
  }
 ],
 "groups": [
  {
   "id": "voyage",
   "label": "VOYAGE",
   "members": [
    "odysseus",
    "ledger"
   ]
  }
 ],
 "callouts": [
  {
   "target": "odysseus",
   "text": "PREPARE PROVISIONS"
  }
 ]
};
export function narrowCallouts(){const spec=structuredClone(calloutsSpec) as typeof calloutsSpec & {layouts?:unknown};(spec.edges[1]! as {id?:string}).id="record";spec.callouts.push({target:"record",text:"Written at landfall"});spec.layouts={narrow:{width:320,height:368,nodes:[{id:"hermes",at:[48,24],size:[224,64]},{id:"odysseus",at:[48,152],size:[224,64]},{id:"ledger",at:[48,280],size:[224,64]}]}};return spec;}
