---
"@schlessera/brain-ui-kit": minor
---

`GoogleApprovalList` and `GoogleAllowanceList` gain a failed-read state and a count of rows they cannot show (#4212). `state: "failed"` says the list couldn't be loaded and that what it holds may still apply. It shows the kit's red error box, never the loading placeholder or the empty line, and with the optional `onRetry` it offers a Try again button that reaches 44px under a coarse pointer. When Try again takes focus with it, focus goes to the list's heading. `unshown` counts rows the host holds but cannot name. While it is above zero, the list never says "None yet" or "Nothing is allowed". An amber notice under the rows gives the count: remembered approvals point to `brain google approvals`, and chat allowances say they still apply. The notice is separate from the revoke-error banner, and both can show at once.
