# Historical investigations

These dated reports preserve observations, source SHAs, measurements and their
limitations. They describe the source and experiment available when each passage
was written; they are historical evidence, not current setup or behavior guidance.
Use the [documentation index](../README.md) for current guides and the
[decision records](../decisions/README.md) for binding choices.

Open evaluation, implementation and verification work belongs in the linked
issues and their dependants. A report's unmeasured behavior or proposed future
experiment is an evidence limitation, not a progress checklist or authorization
to run it. Closed investigations retain their original issue as provenance.
The reports of #838 candidates that were still open on 2026-10-10 were removed
with their harnesses; their authored cases are kept in
[`evals/cases/`](../../evals/README.md).

| Report | Historical evidence | Source issue |
| --- | --- | --- |
| [audit-capability-investigation.md](audit-capability-investigation.md) | Audit suggestion and executable repair evidence. | [#841](https://github.com/schlessera/brain-kit/issues/841) |
| [haiku-5-5-current-path-investigation.md](haiku-5-5-current-path-investigation.md) | Haiku 5.5 reruns of every Sonnet-measured #838 current path, plus two effort sweeps. | [#1611](https://github.com/schlessera/brain-kit/issues/1611) |
| [live-conversation-investigation.md](live-conversation-investigation.md) | Two-engine live voice qualification and interface specification. | [#317](https://github.com/schlessera/brain-kit/issues/317) |
| [note-disposition-investigation.md](note-disposition-investigation.md) | Measured proposal comparison and classifier adoption no-go. | [#840](https://github.com/schlessera/brain-kit/issues/840) |
| [public-website-investigation.md](public-website-investigation.md) | Static website comparison and dated publishing measurements. | [#611](https://github.com/schlessera/brain-kit/issues/611) |
| [turn-surface-routing-investigation.md](turn-surface-routing-investigation.md) | Tool and skill surface inventory and routing mechanics. | [#587](https://github.com/schlessera/brain-kit/issues/587) |
| [visitor-feedback-investigation.md](visitor-feedback-investigation.md) | Visitor paths and mailing-service research. | [#616](https://github.com/schlessera/brain-kit/issues/616) |

Committed evidence manifests and review packets retain their original source
paths and hashes. Resolve those historical identities at their recorded commit;
the current reports live here. Active evaluation tooling uses the new paths, so
a new source freeze reflects the relocation rather than rewriting old receipts.
The harness tests these reports run moved from `tests/` to the experiment tier
under `experiments/` in [#1386](https://github.com/schlessera/brain-kit/issues/1386);
the reproduction commands name their current paths, plus the product test that
now holds any shipped-behaviour assertion split out of a harness file.
