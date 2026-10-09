# brain-kit public website

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Astro static output in `website/`, outside the published package workspaces.
Repository-controlled GitHub Pages with the `/brain-kit/` base is selected in
`../docs/decisions/public-website.md`. The maintainer authorized automatic
publication on relevant main pushes and stable brain-kit releases.

## Users

The homepage primarily serves people evaluating a second brain they own.
The maintainer confirmed this audience in the homepage design session.
Package developers are a secondary audience, with a documentation path.

## Product Purpose

Help people recall context, make decisions and act through a rich personal
knowledge interface. The homepage leads with these benefits and the public
chat/PWA component experience. Markdown, git, CLI and architecture explain the
foundation later. The maintainer explicitly chose this ordering in the design
session.

The first viewport must establish a workspace for knowledge, decisions and
agent work through distinctive components. A search box or an LLM chat alone
does not communicate the product's breadth. The maintainer explicitly requires
that this difference be clear at first glance.

## Positioning

Markdown files are authoritative. The SQLite search index is disposable and
rebuildable. Ordinary CLI capture and full-text search work without API keys.

## Capabilities and Constraints

The chat packages provide streaming conversation, source references, inline
answer blocks, structured questions and ranking, policy-dependent tool
approvals, run inspection, graph exploration and file browsing. Agents operate
on the knowledge files through tools and skills; retrieval is one part of that
work. Ordinary note additions and edits are allowed by the default backends;
archiving and other gated operations require confirmation. The UI supports
voice dictation, reviewed share intake, push subscription
controls and durable local recording. A host supplies the installable PWA
shell, worker and configuration. Properly configured cached shells support
limited offline recording; server history, agent execution and transcription
require connectivity. Device/browser support varies. The hosting starter is
not published yet. The CLI captures, indexes, searches, validates and audits
notes, with MCP and skills connecting coding agents. Extension interfaces are
experimental until 1.0. Optional model and voice providers have their own
privacy and cost implications. A private repository is not encryption.

## Brand Commitments

The name is brain-kit. Use precise, direct language and distinguish shipped,
experimental and unavailable features. All demonstrations use the established
Odysseus world, pinned to 2026-07-12. No private-instance content may be used.

## Evidence on Hand

README.md and canonical docs substantiate claims. The feature-capture catalogue
in `../docs/process/feature-captures.md` supplies real component compositions,
verbatim captions and separate runtime proof. Captures do not establish live
model behavior. No testimonials, customer counts or performance claims exist.

## Product Principles

- Show the final benefit and distinctive UI interactions before implementation.
- Demonstrate context, decisions, approvals and capture on the go.
- Preserve actual application screens and workflows in every interactive demo.
- Place scenario selectors and tour guidance outside the product interface.
- Separate actual application capabilities from standalone component stories.
- Explain ownership and Markdown/git after the experience has earned attention.
- Lead to the maintained quickstart, documentation and public source.
- Preserve canonical Markdown rather than copying guides into marketing copy.
- Keep model use optional and describe its limits honestly.
- Publish only after the rebuilt product demo and artifact checks pass.
