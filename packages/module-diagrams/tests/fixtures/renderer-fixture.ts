export const rendererSpec = {
 schema_version:1, type:"architecture", title:"The homecoming relay", desc:"Odysseus sends word from the raft to Ithaca.", size:"doc-inline",
 nodes:[{id:"raft",label:"The raft",role:"input",at:[40,120],size:[148,64],link:"[[raft-build]]"},{id:"ithaca",label:"Ithaca",role:"focal",at:[400,120],size:[148,64],link:"[[notes/ithaca]]"}],
 edges:[{from:"raft",to:"ithaca",label:"WORD",kind:"primary"}],
 layouts:{narrow:{width:320,height:400,nodes:[{id:"raft",at:[80,40],size:[148,64]},{id:"ithaca",at:[80,240],size:[148,64]}]}}
};
