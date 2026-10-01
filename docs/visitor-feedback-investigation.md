# Visitor paths for public launch

Comparison for [#616](https://github.com/schlessera/brain-kit/issues/616),
under [#608](https://github.com/schlessera/brain-kit/issues/608). The maintainer
must confirm the desired visitor use cases and rule on collection. These are
recommendations for that ruling, not approval to implement forms or collect
visitor data. Visual screenshot/demo capture belongs to #613/#614.

## Recommended launch baseline

Provide useful outbound paths: **Get started**, **Read the docs**, **View the
source**, **Ask a question on GitHub**, **Report a bug on GitHub**, and
**Report a security vulnerability** through the existing security policy.
Offer **GitHub release notifications** only with its actual platform limits
explained. Recommend no first-party signup/contact form, newsletter database,
visitor analytics or tracking integration for this launch.

The existing [README](../README.md#start-here) already gives CLI/agent,
backup/self-hosting and developer paths. [Quickstart](quickstart.md) provides
first capture/search; [the docs index](README.md) supplies the reading order.
Preserve the early/experimental notice, unpublished hosting-template notice,
and the separate onboarding verification tracked by #26. Product visitors
should reach those facts before deciding to try the tool.

The issue chooser already routes
[questions and ideas to Discussions](../.github/ISSUE_TEMPLATE/config.yml),
[bugs to the reproducible report template](../.github/ISSUE_TEMPLATE/bug.yml),
and vulnerabilities to the [security policy](../SECURITY.md#reporting-a-vulnerability).
Keep those existing destinations rather than add another inbox. Website
routes/layout remain #611/#612's decisions; this comparison does not choose
another site architecture.

## Concrete fictional journeys

| Visitor need | Path and honest label | Success evidence | Limit to disclose |
| --- | --- | --- | --- |
| Odysseus wants to capture the warning about the Sirens and find it later. | Get started → quickstart → private template and keyless capture/search. | Odysseus can follow the supported instructions to retrieve the note; #625 supplies accepted final example output. | Local files remain plaintext; optional providers have their own credentials/costs. Do not imply a hosted account or verified live onboarding. |
| Odysseus wants to understand the disposable index or inspect the implementation. | Read the docs → concepts/reference; View the source → the project repository. | The relevant guide and corresponding source are reachable, with maturity and version limits stated. | Anonymous source access must be verified before public launch. |
| Odysseus has a question, or can reproduce a failed command without sharing private notes. | Ask a question on GitHub → Discussions; Report a bug on GitHub → issue chooser. | A visitor can identify the right channel and required report information. Submission is completed on GitHub, not confirmed by the website. | Posting requires a GitHub account and repository access. Public posts may be readable by everyone after launch; use fictional/minimal repros, no credentials or personal corpus. |
| Odysseus wants to know when a new GitHub release appears. | GitHub release notifications → repository, then Watch → Custom → Releases. | The visitor controls notification preferences in their own GitHub account. | This watches GitHub Releases, not npm publication. No update frequency or email delivery is promised by the website. |
| Odysseus finds a vulnerability. | Report a security vulnerability → SECURITY.md. | The visitor reaches the existing private reporting instructions. | Do not send vulnerability details into a public issue or ordinary discussion; private-reporting availability must be verified at launch. |

These are a review of proposed paths, not executed submissions or proof of a
new visitor's comprehension. No account was subscribed, message posted or
form submitted during the investigation. The table's success signals are
acceptance checks for the eventual pages, not tracking events to collect.

## Source and platform evidence

Read-only repository metadata on 2026-10-01 reports Issues and Discussions
enabled, Pages absent, and the repository currently private. The Releases API
returns no releases. Those facts explain why an anonymous public-visitor
walkthrough cannot currently establish working public source/feedback links.
Intended open-source status is not public accessibility. #611/#615 must verify
source/destination access and the selected host before launch; no visibility
or settings change is performed here.

GitHub documents
[repository access and participation prerequisites](https://docs.github.com/en/discussions/collaborating-with-your-community-using-discussions/participating-in-a-discussion)
for Discussions, and
[custom repository notifications](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)
including Releases. Existing empty Releases are not an email signup service or
evidence that every npm release sends a notification. Do not describe that path
as “join the mailing list” or display “you are subscribed” on the website.

The existing security policy is the navigation destination, not a new
promise about a form. GitHub's
[private-reporting documentation](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)
requires the feature to be enabled on the public repository. Check that
availability and the policy's usable contact path as part of #615's launch
review; a committed issue-chooser link alone does not prove it.

If #611 selects GitHub Pages, GitHub describes it as
[static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
and states that it records visitor IP addresses for security. A collection-free
website application is therefore not a promise that the host stores no data.
A first-party form would still need a separately selected submission/delivery
service and owner; static page hosting alone does not supply that workflow.
This comparison selects no such service and makes no unverified vendor claim.

## Alternatives and their costs

| Option | Visitor benefit and fields | Maintenance, access and data lifecycle | Recommendation |
| --- | --- | --- | --- |
| Existing outbound paths | Docs/source can be read without first-party input once public. GitHub handles question/bug posting and optional notification preferences. No first-party fields. | Reuse existing moderation and templates. Explain GitHub login and public posting; keep destinations healthy. GitHub/hosting retain their own platform data. The project maintains no extra contact/list database. | Initial baseline: it supports trying, understanding and discussing the product without another service. |
| Minimal release-notification signup | An email address and explicit, unchecked release-notification consent; no name, job title or profile fields. Would serve visitors who want announcements without GitHub. | Select a delivery/list owner, verified opt-in and unsubscribe/deletion handling, abuse limits, sender configuration and a publication cadence. Build accessible validation and distinguish pending confirmation from active subscription. | Only if the maintainer confirms that non-GitHub email updates are a required launch workflow. No vendor or list is selected. |
| Minimal feedback/contact form | Required message; optional reply email. No name, attachment, phone number or automatic marketing consent. Would serve visitors unable to post on GitHub. | Select a project-owned destination and response owner, moderation/rate limits, retention/deletion procedure and incident handling. Explain whether messages are private and whether a reply is possible. A form is an additional inbox, not a replacement for reproducible issue reports. | Only if a concrete non-GitHub/private-contact workflow warrants the continuing ownership cost. |

The two collection alternatives are fully conditional proposals. If either is
chosen, its implementation issue needs a named service/project-owned
destination and access prerequisite before coding; placeholders are not a
working destination. The maintainer must approve retention and response
ownership, not merely say “add a form.”

For a signup option, propose removing unconfirmed entries after **7 days**,
retaining confirmed entries only while subscribed, stopping delivery on
unsubscribe, and deleting the entry within **7 days** of a deletion request.
Record consent purpose, timestamp and policy revision alongside the address.
A provider's suppression records, backups and logs need a documented limit
and deletion treatment before that policy can be promised. These periods are
proposed product requirements for the maintainer ruling.

For a feedback option, propose a **90-day** retention limit for the message and
optional reply address, deletion within **7 days** of a request, and explicit
consent before using private feedback to create a sanitized public report.
Identifying content stays excluded under the public-data rules. Do not use a
feedback address for announcements. If a useful report becomes public project
work, the maintainer creates a sanitized issue following the existing routing
and leakage rules. Destination logs/backups need their own documented limits.

## Interaction and confirmation requirements

Outbound labels name the destination: “Ask a question on GitHub” makes the
handoff clear; “Contact us” would obscure the actual path. Use ordinary named
links, visible focus, meaningful order and access requirements beside the
feedback choices. No popup, email wall or forced signup interrupts the
get-started path. The designed pages still require #612/#615's real-browser
keyboard, mobile, zoom and accessibility acceptance.

For a later approved signup, keep a persistent **Email address** label,
explain the update purpose before consent, and show an actionable invalid
address error. “Check your email to confirm release notifications” means an
accepted request awaiting confirmation; “Subscription confirmed” is shown only
after confirmation. Delivery failure keeps a retry available and never reports
success. Unsubscribe confirmation describes the real delivery state.

For an approved feedback form, use persistent **Message** and **Reply email
(optional)** labels and **Send feedback** as the action. Confirm receipt only
after durable acceptance by the selected destination. Do not claim the
maintainer has read it or promise a response time without that commitment.
If acceptance fails, preserve the input and offer retry; do not silently route
it into a public issue. Errors and status changes need accessible association
and announcement. No form or submission behavior is implemented here.

## Ruling and implementation boundary

The concrete recommendation is: confirm get-started, docs/source, GitHub
question/bug feedback and optional GitHub release notifications as the visitor
use cases; choose the outbound baseline; decline first-party newsletter,
contact forms and analytics for launch. A documented no is a valid completed
outcome of #616, not deferred form implementation.

After the maintainer rules, record the durable choice and why the alternatives
were rejected, reconcile #612's visitor path requirements and #615's access
checks, and close #616 only when its criteria are met. Outbound links can be
implemented within those existing children. If collection is selected instead,
file a genuinely scoped native child under #608 containing the approved
fields, destination/owner, consent/lifecycle rules, abuse/accessibility,
truthful states and keyless verification. That is the point to select and
source-verify the service. This investigation authorizes no publication,
visitor data collection, message delivery, signup or paid account.
