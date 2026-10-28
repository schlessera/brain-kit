---
"@schlessera/brain-ui-react": patch
---
Keep live conversation capture running when the first automatic background task receives its backend session identity. Associate only the admitted request and host turn, preserve independent typed drafts, and retain teardown when navigating to another chat. After leaving voice, preserve legacy typed-session adoption even when the host omits draft correlation, while rejecting late known contextual request identities.
