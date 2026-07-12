# brainform — Planning Workspace

Planning documents for open-sourcing Alain Schlesser's personal knowledge base ("brain", `/home/alain/brain`) and its UI companion (brain-ui, `/home/alain/dev/brain-ui`) as **brainform**: a self-serve, skill-driven "DIY brain infra" that a stranger can bootstrap with zero of Alain's personal data.

These documents were produced 2026-07-12 via multi-agent exploration of both repos (all `file:line` references verified on that date) plus targeted web research. They are written for handoff: a fresh agent should be able to execute any phase from these docs alone.

## Read this first

- The **product vision** and all **locked decisions** are in [plan/00-overview.md](plan/00-overview.md). Nothing in the other docs overrides it.
- Execution order and gates: the sequencing table in 00-overview. Phases 1–2 happen **inside Alain's private brain repo** (his daily driver — every change is gated by byte-diff snapshots), phases 3–6 build the public repos.
- The private repo `schlessera/brain` **never goes public**. All public repos get fresh git history.

## Document map

| Doc | Contents |
|---|---|
| [plan/00-overview.md](plan/00-overview.md) | Vision, locked decisions, guiding principles, sequencing, verification, open items |
| [plan/01-core-architecture.md](plan/01-core-architecture.md) | Repo/package topology, `brain.config.ts` schema, taxonomy resolver, module system, `/new-module`, genericizing jobs/speaking/finance, testing strategy |
| [plan/02-onboarding.md](plan/02-onboarding.md) | Onboarding skill suite (`/brain-init`, `/brain-doctor`, `/brain-import`, `/brain-module`), first-run funnel, CLAUDE.md layering, degradation ladder |
| [plan/03-brain-ui.md](plan/03-brain-ui.md) | Auth modes, deployment generalization, encryption-at-rest exploration, `/brain-host`, cost expectations, brain-ui scrub list |
| [plan/04-extensibility.md](plan/04-extensibility.md) | The seam architecture: meta-mechanism, LLM/agent/STT/renderer/skill-emitter seams, pi vs OMP vs Claude SDK decision, TypeScript interface sketches |
| [plan/05-migration.md](plan/05-migration.md) | Phased migration of Alain's brain onto the extracted packages, gates and rollback per phase |
| [plan/06-launch.md](plan/06-launch.md) | Docs architecture, SECURITY.md outline, versioning/CI, community surface, publishing/scrubbing checklist |
| [research/brain-repo-analysis.md](research/brain-repo-analysis.md) | Verified coupling analysis of `/home/alain/brain` (file:line) |
| [research/brain-ui-analysis.md](research/brain-ui-analysis.md) | Verified analysis of `/home/alain/dev/brain-ui` (file:line) |
| [research/pi-omp.md](research/pi-omp.md) | pi / oh-my-pi research: SDK surfaces, auth constraint, decision rationale, sources |
| [research/prior-art-and-naming.md](research/prior-art-and-naming.md) | Prior-art landscape, distribution-model research, name availability checks |

## Key facts (for orientation)

- **Name**: brainform. GitHub `schlessera/brainform` + `schlessera/brainform-template`; npm `@brainform/*` (scope + bare name verified free 2026-07-12). The CLI bin and `brain_*` MCP tool names stay `brain`.
- **License**: MIT, both repos. **Org**: `schlessera`.
- **Distribution**: versioned core package + thin template repo; user repos hold `brain.config.ts` + content.
- **Agent strategy**: two brain-ui backends behind one `AgentBackend` seam — purpose-built on upstream pi (`@earendil-works/pi-coding-agent` SDK, OSS default) and Claude Agent SDK (subscription-economics path, Alain's driver). Full OMP is deliberately NOT a foundation.
- **Contract**: `/home/alain/brain/scripts/INTEGRATION.md` is the stable surface consumed by brain-ui; it must hold through every phase and becomes the public compatibility contract.
