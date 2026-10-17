import type { DiagramSpec } from "../../src/spec.js";
export const axisExamples = {
  "sequence": {
    "schema_version": 1,
    "title": "Release from Ogygia",
    "desc": "The release order reaches Odysseus on 2026-07-12.",
    "size": "doc-inline",
    "nodes": [
      {
        "id": "zeus",
        "label": "Zeus"
      },
      {
        "id": "hermes",
        "label": "Hermes"
      },
      {
        "id": "calypso",
        "label": "Calypso"
      },
      {
        "id": "odysseus",
        "label": "Odysseus"
      }
    ],
    "edges": [],
    "type": "sequence",
    "axis": {
      "kind": "sequence",
      "messages": [
        {
          "id": "release",
          "from": "zeus",
          "to": "hermes",
          "label": "RELEASE ORDER",
          "focal": true
        },
        {
          "id": "deliver",
          "from": "hermes",
          "to": "calypso",
          "label": "DELIVER ORDER"
        },
        {
          "id": "raft",
          "from": "calypso",
          "to": "odysseus",
          "label": "BUILD A RAFT"
        },
        {
          "id": "promise",
          "from": "odysseus",
          "to": "calypso",
          "label": "SWEAR NO TRICK"
        },
        {
          "id": "tools",
          "from": "calypso",
          "to": "odysseus",
          "label": "TOOLS · 4 DAYS",
          "kind": "return"
        },
        {
          "id": "sail",
          "from": "odysseus",
          "to": "odysseus",
          "label": "SAIL 17 DAYS",
          "kind": "async",
          "note": "Scheria by July 29"
        }
      ]
    }
  },
  "swimlane": {
    "schema_version": 1,
    "title": "The raft handoff",
    "desc": "Calypso prepares the tools and Odysseus builds the raft on 2026-07-12.",
    "size": "doc-inline",
    "nodes": [
      {
        "id": "tools",
        "label": "Prepare tools"
      },
      {
        "id": "raft",
        "label": "Build raft"
      },
      {
        "id": "sail",
        "label": "Set sail"
      }
    ],
    "edges": [
      {
        "from": "tools",
        "to": "raft",
        "label": "HANDOFF",
        "kind": "primary"
      },
      {
        "from": "raft",
        "to": "sail",
        "label": "READY"
      }
    ],
    "type": "swimlane",
    "axis": {
      "kind": "swimlane",
      "lanes": [
        {
          "id": "calypso",
          "label": "CALYPSO"
        },
        {
          "id": "odysseus",
          "label": "ODYSSEUS"
        }
      ],
      "steps": [
        {
          "node": "tools",
          "lane": "calypso"
        },
        {
          "node": "raft",
          "lane": "odysseus"
        },
        {
          "node": "sail",
          "lane": "odysseus"
        }
      ]
    }
  },
  "timeline": {
    "schema_version": 1,
    "title": "Voyage milestones",
    "desc": "The voyage runs from Ogygia to the homecoming.",
    "size": "doc-inline",
    "nodes": [
      {
        "id": "departure",
        "label": "Leave Ogygia",
        "role": "focal"
      },
      {
        "id": "scheria",
        "label": "Reach Scheria"
      },
      {
        "id": "ithaca",
        "label": "Reach Ithaca"
      }
    ],
    "edges": [],
    "type": "timeline",
    "axis": {
      "kind": "timeline",
      "events": [
        {
          "node": "departure",
          "date": "2026-07-12"
        },
        {
          "node": "scheria",
          "date": "2026-07-29"
        },
        {
          "node": "ithaca",
          "date": "2026-08-01"
        }
      ]
    }
  },
  "gantt": {
    "schema_version": 1,
    "title": "Raft preparation",
    "desc": "Odysseus prepares the raft before setting sail on 2026-07-12.",
    "size": "doc-inline",
    "nodes": [
      {
        "id": "timber",
        "label": "Gather timber"
      },
      {
        "id": "build",
        "label": "Build raft",
        "role": "focal"
      },
      {
        "id": "provisions",
        "label": "Pack supplies"
      }
    ],
    "edges": [],
    "type": "gantt",
    "axis": {
      "kind": "gantt",
      "phases": [
        {
          "id": "preparation",
          "label": "PREPARATION"
        }
      ],
      "tasks": [
        {
          "node": "timber",
          "start": "2026-07-08",
          "end": "2026-07-09",
          "phase": "preparation"
        },
        {
          "node": "build",
          "start": "2026-07-09",
          "end": "2026-07-12",
          "phase": "preparation"
        },
        {
          "node": "provisions",
          "start": "2026-07-11",
          "end": "2026-07-12",
          "phase": "preparation"
        }
      ],
      "marker": "2026-07-12"
    }
  }
} satisfies Record<string,DiagramSpec>;
