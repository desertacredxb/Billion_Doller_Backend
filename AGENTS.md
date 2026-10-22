# Preserve approved behavior

Keep owner-approved flows unchanged during unrelated fixes. If a requested change affects an existing flow, check its callers, UI contract and regression tests before publishing. Update the agreed contract only when the owner explicitly requests a different behavior.

Read `docs/approved-behavior.md` before changing an existing feature. That baseline covers the owner's two-day review. Verify affected dependent flows as well as the changed endpoint. Existing tests and CI are regression checks, not a claim that branch protection or a permanent repository write lock is configured.

## Client identity corrections (owner confirmed 22 October 2026)

- Keep client **Edit name & resubmit → Save details → Resubmit verification** available for ordinary, unapproved review, provider resubmission and retryable failures.
- Only full name is editable here. The owner removed the address option; do not reintroduce it. Address, email, mobile, nationality and residence changes go through support.
- Saving a correction retires the old session correlation. A fresh signed Veriff check must approve the changed details; stale approvals cannot verify them.
- Keep explicit owner reviews, security holds, UAE restrictions and duplicate-mobile checks. Approved clients must not silently lose verification.
- Run `node --test test/veriff.test.js` and the full existing backend suite before publishing changes to this flow.
- Preserve the confirmed policy accepting all document classes approved by the current live Veriff integration, with the existing signature/session/account checks.
