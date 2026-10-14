# Discovery browser fixtures

`discovery-odyssey.json` is the actual website Odyssey Discovery response at
`maxDepth=8`, generated from source tree `08b4f15fc494749349c94c8352b9c6ae824faa89`.
`discovery-odyssey-meta.json` holds the matching actual metadata: 608 corpus
nodes, 3,981 corpus edges and the root `goals/return-to-ithaca.md`.
The corpus date is `2026-07-12`. It contains 506 visible nodes and 3,551 directed
edges, with outgoing-hop populations 1 root / 9 / 130 / 204 / 118 / 37 / 6 / 1.
Its SHA-256 is
`1ef6feed15987cdc79b22e26ebf578b92da03b80d1d0e0e361ea42fa242e2ed4`.

The generator is (`knowledgeResponse`, `website/src/demo/knowledge.ts:85-124`).
From the repository root:

```sh
bun -e 'import {knowledgeResponse} from "./website/src/demo/knowledge.ts";
  const data = await knowledgeResponse(new URL("http://localhost/api/graph/discovery?maxDepth=8"))!.json();
  await Bun.write("packages/ui-react/tests/fixtures/discovery-odyssey.json", JSON.stringify(data, null, 2));'
```

`discovery-scenes.ts` derives four explicitly edited variants from that
snapshot: the root and hop-1 notes for sparse coverage; the largest predecessor
branch for dominant coverage; removal of one hop-1 predecessor with its
children retained for truncation coverage; and assigned/absent community
values on hop-1 notes for mixed-community ordering coverage. Subsets retain
only edges whose endpoints remain visible. No note titles, paths or canonical
Odyssey facts are invented by these variants.

The browser suite saves each original scene before interaction, then verifies
keyboard/list selection, native pointer picking, disclosure focus,
presentation/resize invariance and changed-data notices. The canvas, list,
explanation and notice have separately named dark/paper baselines. The saved
capture matrix is an artifact, rather than a claim that geometric bounds alone
establish readability; dense phone overview usability remains constrained by
individual mark size and the grouped list/zoom remedies.
