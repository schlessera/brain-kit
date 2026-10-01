# Visitor paths for public launch

Comparison for [#616](https://github.com/schlessera/brain-kit/issues/616),
under [#608](https://github.com/schlessera/brain-kit/issues/608). The maintainer
selected outbound visitor paths plus email release notifications on
2026-10-01 and required online research before choosing a mailing service.
The service comparison below supported the Buttondown selection. The current
rulings select a website HTML form, a maintainer-operated project newsletter
and email-only visitor fields. Consent is clear release-only wording beside
Subscribe followed by email confirmation, without an additional checkbox.
Retention/deletion and sending policy remain for the maintainer to settle.
Visual screenshot/demo capture belongs to #613/#614.

## Approved visitor paths

Provide useful outbound paths: **Get started**, **Read the docs**, **View the
source**, **Ask a question on GitHub**, **Report a bug on GitHub**, and
**Report a security vulnerability** through the existing security policy.
Offer **GitHub release notifications** only with its actual platform limits
explained. Add an optional email release-signup path for visitors who do not
use GitHub, once the remaining retention/deletion and sending brief is complete.
The maintainer did not select a private contact form. No visitor analytics or
tracking integration is approved by the release-signup choice.

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
The selected Buttondown public form supplies that submission path; its actual
configuration and browser behavior still need verification.

## Alternatives and their costs

| Option | Visitor benefit and fields | Maintenance, access and data lifecycle | Recommendation |
| --- | --- | --- | --- |
| Existing outbound paths | Docs/source can be read without first-party input once public. GitHub handles question/bug posting and optional notification preferences. No first-party fields. | Reuse existing moderation and templates. Explain GitHub login and public posting; keep destinations healthy. GitHub/hosting retain their own platform data. The outbound paths need no extra contact/list database. | Selected alongside release email signup. |
| Minimal release-notification signup | Selected personal-information field: email address only, with clear release-only wording beside Subscribe followed by email confirmation; no additional checkbox. No name, job title or profile fields. Serves visitors who want announcements without GitHub. | The maintainer operates the Buttondown newsletter; settle unsubscribe/deletion handling, abuse limits, sender configuration and a publication cadence. Build accessible validation and distinguish pending confirmation from active subscription. | The workflow, Buttondown, HTML form, maintainer ownership and email-only fields are selected. Consent is selected; retention/deletion and sending policy remain open. |
| Minimal feedback/contact form | Required message; optional reply email. No name, attachment, phone number or automatic marketing consent. Would serve visitors unable to post on GitHub. | Select a project-owned destination and response owner, moderation/rate limits, retention/deletion procedure and incident handling. Explain whether messages are private and whether a reply is possible. A form is an additional inbox, not a replacement for reproducible issue reports. | Only if a concrete non-GitHub/private-contact workflow warrants the continuing ownership cost. |

Release signup is the selected collection workflow; retention/deletion and
sending policy still require a ruling. A private contact form remains an
unselected alternative. The signup implementation issue needs a named
service/project-owned destination and access prerequisite before coding;
placeholders are not a working destination. The maintainer must approve
retention/deletion and the remaining sending policy before the form ships.

The initial signup proposal was to remove unconfirmed entries after **7 days**,
retain confirmed entries only while subscribed, stop delivery on unsubscribe,
and delete the entry within **7 days** of a deletion request.
Record consent purpose, timestamp and policy revision alongside the address.
A provider's suppression records, backups and logs need a documented limit
and deletion treatment before that policy can be promised. These periods are
initial proposals, not selected policy. The current Buttondown cleanup
assessment below qualifies the available intervals and deletion semantics.

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
place clear release-only wording beside Subscribe, add no consent checkbox,
explain email confirmation, and show an actionable invalid
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

The recorded workflow ruling is: provide get-started, docs/source, GitHub
question/bug feedback and optional GitHub release notifications, together with
email release updates for visitors who do not use GitHub. The maintainer selected Buttondown after the mailing-service comparison
below, with website HTML presentation, maintainer ownership and email-only
visitor fields. Consent is clear release-only wording beside Subscribe
followed by email confirmation, without a separate checkbox. Retention/deletion
and sending policy remain unresolved. A private
contact form and visitor analytics were not selected.

After the maintainer rules, record the durable choice and why the alternatives
were rejected, reconcile #612's visitor path requirements and #615's access
checks, and close #616 only when its criteria are met. Outbound links can be
implemented within those existing children. For the approved signup workflow,
file a genuinely scoped native child under #608 containing the approved
fields, destination/owner, consent/lifecycle rules, abuse/accessibility,
truthful states and keyless verification. Carry the recorded provider/presentation/owner/field rulings and the remaining
policy choices into that implementation brief. This investigation authorizes no publication,
visitor data collection, message delivery, signup or paid account.

## Mailing-service research and comparison

Primary-source research dated **2026-10-01** widened discovery beyond the
initial Buttondown/MailerLite/listmonk leads to include EmailOctopus and Brevo.
This is a documentation assessment, not a live account, delivery or browser
trial. No subscriber was created and no message was sent. The comparison's
recommendation is judgment about the approved release-only workflow, not a
measured usability or deliverability ranking.

Use the same criteria for each candidate: a small optional email signup from
an Astro/GitHub Pages site; confirmation before announcements; honest pending,
confirmed and error states; unsubscribe, deletion and subscriber export;
current costs/limits; release-to-email work; accessibility and continuing
operating ownership. Email-only fields and clear release-only signup wording
followed by email confirmation are selected. Open/click engagement tracking
is disabled under the existing maintainer ruling; lifecycle periods above
remain proposed product requirements.
Subscriber metadata and service logs can contain more than the visible form
fields. Static hosting should never expose a secret subscriber/campaign API
key; a hosted signup link or documented public form avoids requiring a new
application backend for signup. Each candidate's configured behavior still
needs verification before collection ships.

### Viable options and costs

| Candidate | Documented capacity and setup | Pros for release announcements | Cons and operating cost |
| --- | --- | --- | --- |
| **A: Buttondown** | [Free for 100 subscribers](https://buttondown.com/pricing), assuming at most one full-list email per day. Hosted signup page, ordinary HTML POST embed and iframe; [confirmation is the default](https://docs.buttondown.com/double-opt-in). | Markdown editing fits release notes. [Tracking is opt-in](https://buttondown.com/about). Managed sending avoids operating a mail service. [RSS can create drafts or send messages](https://docs.buttondown.com/rss-to-email). | Smallest free audience. Pricing lists RSS at an additional $9/month and teams at $79/month; larger-list base cost needs an actual audience quote. Do not assume multiple operators are free. Hosted signup/confirmation, sender setup and subscriber-data policy still need acceptance. |
| **B: EmailOctopus** | [Free for 2,500 subscribers and 10,000 monthly emails](https://emailoctopus.com/pricing), with branding, one form, one landing page and one user. [Hosted pages, embeds and API signup](https://help.emailoctopus.com/article/40-adding-contacts-to-a-list) are documented. | Much more free capacity; managed sending, configurable confirmation, unsubscribe/deletion and export cover the core workflow. Suitable for manually prepared release announcements. | [Single opt-in is the default](https://help.emailoctopus.com/article/36-how-to-edit-double-opt-in). [Open/click tracking is on by default and disabled per campaign](https://help.emailoctopus.com/article/187-campaign-tracking). [No native RSS-to-email](https://help.emailoctopus.com/article/169-do-you-support-rss). Extra operators or removing branding needs paid capacity; growth pricing depends on the selected tier. |
| **C: MailerLite** | [Free for 250 active subscribers and 2,500 monthly emails](https://www.mailerlite.com/help/free-plan-update-faq), with two seats and three forms. Form confirmation defaults on; [API/integration confirmation is a separate setting](https://www.mailerlite.com/help/how-to-use-double-opt-in-when-collecting-subscribers). | Broader forms/automation and two free operators may help a small team. CSV export and subscriber controls are documented; managed sending avoids an operated mail service. | Free limits changed in June 2026. [RSS campaigns](https://www.mailerlite.com/help/how-to-create-an-rss-campaign) and customized confirmation emails require a paid plan. [Tracking is enabled by default](https://www.mailerlite.com/help/how-to-enable-and-disable-tracking). Ordinary deletion retains information; [forgetting takes 30 days](https://www.mailerlite.com/help/how-to-delete-or-forget-a-subscriber), conflicting with an all-data seven-day erasure promise. |
| **D: listmonk** | [Free/open-source software](https://listmonk.app/); [Postgres](https://listmonk.app/docs/installation/), a running service and [SMTP](https://listmonk.app/docs/configuration/) are required. Public subscription API permits omitting a name; double-opt-in lists are supported. | Greatest control over subscriber storage and templates. Subscriber export/delete APIs and public subscription-management data export/wipe are documented. Campaign APIs allow an application-owned release workflow. | Software price excludes hosting, mail delivery and operator time. The project owns patching, backup/deletion policy, availability, bounce processing and sender reputation. Campaign tracking/configuration must be reviewed. No hosted service, operating owner or infrastructure budget is selected by this option. |

The services are viable at the documentation level for their described
workflow. Account acceptance, sender verification, exact selected-plan
features, configured privacy behavior and accessibility are not established
by reading docs. There is no measured claim that one delivers more reliably.

Brevo was screened as another managed candidate. Its
[free plan permits 300 email sends per day; Starter begins at $9/month](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans).
For a list above 300, a single same-day release announcement cannot fit the
free allowance. Paid plans remove the daily limit. That and its broader
marketing scope make it a lower-priority fit here, rather than evidence that
Brevo cannot support release mail. It is not fully qualified in this report
and is excluded from the recommended shortlist. Discovery was not limited to
the original three leads; an exhaustive market survey is unnecessary for this
bounded workflow.

### Confirmation, portability and deletion

| Candidate | Source-backed behavior | Qualification needed for the proposed policy |
| --- | --- | --- |
| Buttondown | [Double opt-in](https://docs.buttondown.com/double-opt-in) keeps signups unactivated until confirmation. [Portal](https://docs.buttondown.com/portal) supports unsubscribe. [CSV export](https://docs.buttondown.com/data-exports-subscriber), [delete](https://docs.buttondown.com/api-subscribers-delete) and [unsubscribe versus delete](https://docs.buttondown.com/api-changelog-2024-09-30) are documented. | Preserve the confirmation requirement. Establish treatment of unconfirmed entries, suppression, backups and logs; deleting a list entry does not prove erasure of every service copy. |
| EmailOctopus | Enabling [double opt-in](https://help.emailoctopus.com/article/36-how-to-edit-double-opt-in) puts form/API signups in Pending until confirmation; dashboard/import additions bypass that flow. [Delete/unsubscribe](https://help.emailoctopus.com/article/176-delete-or-unsubscribe-contact) are distinct; deletion also removes contact activity. [Export](https://help.emailoctopus.com/article/116-exporting-contacts-from-a-list) includes subscribed or unsubscribed contacts. | Use one release list, enable confirmation and disable campaign tracking. Deletion loses the local unsubscribe record, so resubscription/import behavior and service backup/log treatment need a documented policy. |
| MailerLite | [Exports](https://www.mailerlite.com/help/how-to-export-subscribers) cover active, unconfirmed and unsubscribed contacts. [Delete, forget and unsubscribe](https://www.mailerlite.com/help/how-to-delete-or-forget-a-subscriber) differ; deletion is recoverable, while forgetting completes after 30 days. | Do not equate a successful delete API call with erasure. A maintainer choosing this service must reconcile the proposed seven-day period with its documented forgetting interval. Check API confirmation separately from form settings. |
| listmonk | [Concepts](https://listmonk.app/docs/concepts/) explain confirmed-only delivery for double-opt-in lists. [Subscriber APIs](https://listmonk.app/docs/apis/subscribers/) document public signup, unsubscribe, export and delete. [System templates](https://listmonk.app/docs/templating/) expose subscriber export/wipe controls. | Configure double opt-in; prove the public email-only path. The project must implement its chosen unconfirmed-entry cleanup and deletion policy across its database, backups, logs and mail processor. Control is an operating responsibility, not proof that retention is already correct. |

The seven-day periods above are proposals. This research does not silently
approve a longer period or promise an unsupported seven-day global purge.
Choose and document the actual deletion/suppression/backup treatment with the
provider and operating owner before publication.

### Buttondown cleanup qualification — 2026-10-02

The current [subscriber-cleanup guide](https://docs.buttondown.com/subscriber-cleanup)
documents an opt-in setting: 30 days for unactivated/complained entries and
7 days for unsubscribed/blocked entries. Cleanup normally soft-deletes records
to protect opt-outs from old CSV imports. Hard-deletion mode is available by
request; the operator must also update stored exports and other copies.
The earlier seven-day unconfirmed-entry proposal does not match this documented
managed cleanup interval, and neither policy has been selected or configured.

The [older API changelog](https://docs.buttondown.com/api-changelog-2024-09-30)
describes DELETE as permanent list deletion, while automatic cleanup expressly
uses soft deletion. Verify the chosen account's exact cleanup/API behavior;
a list deletion result alone does not establish erasure of every service copy.
The [privacy policy](https://buttondown.com/legal/privacy) describes isolated
backup retention without a fixed purge interval; the
[DPA](https://buttondown.com/legal/data-processing-agreement) establishes no
seven-day global-purge deadline. Publish confirmed suppression, backup and log
treatment before launch. The next maintainer ruling is standard soft-deletion
cleanup versus provider-enabled hard deletion at the documented intervals,
including how verified erasure requests and project-held copies are handled.

### Release sending and website integration

For each managed service, a manually reviewed release campaign is the simplest
initial workflow: the operator checks what actually shipped, writes the
announcement and sends it through the service. This requires continuing
release-editor ownership even when the service handles delivery. A hosted
signup link can be integrated in the static site without maintaining a
subscriber proxy. A public form embed is an alternative, with a larger
browser-accessibility and error-flow review surface.

Buttondown's documented RSS option can make a draft from a public release
feed for review; its additional cost belongs in the chosen plan. EmailOctopus
has no native RSS-to-email; any automation adds integration work. MailerLite
has paid RSS campaigns. listmonk's
[campaign API](https://listmonk.app/docs/apis/campaigns/) supports an
application-owned integration, with credentials and duplicate/retry policy
managed outside the browser. None of these capabilities proves a working
npm-publication-to-email integration. If feed automation is wanted, first
establish the authoritative release source, public feed availability and
handling of prereleases, corrections, retries and old entries.

For all candidates, the implementation review must cover keyboard focus,
persistent field labels, mobile/zoom, associated errors, confirmation status,
unsubscribe and deletion access. The existence of vendor-hosted forms is not
an accessibility certification. No live signup/browser/delivery acceptance is
claimed here.

### Provider ruling and remaining choices

The maintainer [selected A: Buttondown on 2026-10-01](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5940845881)
after reviewing the researched options. This selects the service for the
approved release-signup workflow. On 2026-10-02 the maintainer selected
**presentation B: an HTML signup form styled on the project website**,
superseding the earlier hosted-link A choice. Use an ordinary form POST to
Buttondown's public embed-subscribe endpoint; its
[official guide](https://docs.buttondown.com/building-your-subscriber-base)
requires this flow so validation and CAPTCHA/challenges can complete. The
website owns accessible fields, validation and focus, while Buttondown handles
the submission response. Do not promise an entirely in-page confirmation flow
or put a secret subscriber API key in browser code. The maintainer also
[selected operating ownership](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5941692714)
of the dedicated project newsletter and
[email-only visitor fields](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5941746319).
The maintainer [selected consent and confirmation](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5942150979):
clear release-only wording beside Subscribe followed by email confirmation,
without a separate checkbox, and open/click engagement tracking disabled.
Retention/deletion and
release-sending policy remain unresolved on #616. Verify the available public
submission destination and account configuration before launch; these rulings do not establish working
account setup or live collection.

The comparison's rationale follows:

Recommend **A, Buttondown**, for a focused release list when a small initial
free allowance and paid growth are acceptable. Markdown, default confirmation
and optional tracking fit the intended workflow with fewer configuration
exceptions. The initial research recommended a hosted signup destination;
the maintainer's later HTML form choice supersedes that presentation
recommendation. Manually reviewed release emails remain a sending-policy
recommendation, rather than an additional maintainer ruling.

Choose **B, EmailOctopus**, when larger free capacity matters more than those
defaults, accepting explicit confirmation and per-campaign tracking controls.
**C, MailerLite**, is a defensible choice for richer automation or two free
operators, with a smaller free list and an explicit deletion-policy tradeoff.
Choose **D, listmonk**, only with a commitment to operating its service and
mail infrastructure. This preference order is an inference from the approved
release-only purpose and documented capabilities, not a universal product
ranking.

The remaining choices are retention/deletion and release-sending policy.
Provider, signup presentation, operating ownership, minimal fields and
consent/confirmation are recorded above. The final durable record and scoped
native implementation/design child under #608 must carry those actual
rulings; the comparison does not supply them by implication.
