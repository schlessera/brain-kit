# Decisions

Why things are the way they are. One file per body of work, each carrying the
alternatives that were rejected and the measurements that decided between them.

A decision record is not a status file. Nothing here says what is done or what
is next — that is the issue tracker's job, and
[`docs/process/github.md`](../process/github.md) says how it does it. These
files answer a different question: *if I am about to change this, what did
somebody already learn the hard way?*

| Record | What it decides |
| --- | --- |
| [design-kit.md](design-kit.md) | The design kit and the chat surface: D1–D42, dated. Component API, tokens, the light theme, the accessibility gate, the in-chat tool contracts, the classification pass. |
| [hardening.md](hardening.md) | The 2026-09-06 layer review's fixes: the origin policy, the sessions epoch, subprocess environment filtering, the shared bridge tools, self-describing backends, and why they shipped in that order. |
| [container-privilege.md](container-privilege.md) | How the server and the agent are separated in the deployment container, and the two measurements that decided it. Supersedes hardening.md's decision 8. |
| [session-principals.md](session-principals.md) | Why a session carries a named, revocable identity instead of one global cookie epoch. |
| [agent-observability.md](agent-observability.md) | Runs, spans, the Activity surface, the failure inbox and the digest. |
| [cost-tracking.md](cost-tracking.md) | List price versus effective cost, and why unknown cost is never rendered as zero. |
| [design-feedback.md](design-feedback.md) | The design defects building the kit found, the measurement behind each, and the ruling that settled it. Cited by section number from `packages/ui-kit` source. |
| [map-geometry.md](map-geometry.md) | Why `MapView` draws committed OpenStreetMap geometry rather than fetching tiles. |
| [voice-permission.md](voice-permission.md) | What a tool approval is in a spoken conversation: the voice tool posture, why voice may refuse but never grant, and what that shares with the restricted execution profile. |

## Writing one

Write a decision record when a choice **binds future work** — when a later
change that does not know about it would be wrong. Not for every design
discussion, and not for anything the code already says clearly.

What makes these useful is the part most records leave out:

- **The alternatives, and why each lost.** A record that only states what was
  chosen cannot stop the rejected option being proposed again next year.
- **The measurement.** Several decisions here exist because something was
  measured rather than argued: 486 of 486 coastline rings wound the same way; an
  accessibility gate giving 503 pass / 0 fail at `'todo'` and 497 / 6 at
  `'error'`; five comparison prompts producing zero tool calls after the prompt
  was rewritten twice. Those numbers are the record.
- **The corrections.** When a decision turns out to be wrong, the entry is
  superseded in place with the correction underneath it. The pair is more useful
  than either half — `container-privilege.md` exists because `hardening.md`'s
  decision 8 was written before the spike ran.

Keep them append-only. Supersede an entry; do not rewrite one.

These files are inside the leakage gate, like the whole tree. Repo-relative
paths, and attribute a ruling to "the maintainer" rather than by name.
