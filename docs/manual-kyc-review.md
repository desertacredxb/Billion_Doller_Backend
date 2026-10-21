# Owner manual KYC review

Owners can record a manual approval or rejection for a submitted live Veriff session from Users. They must review the documents and provider result, confirm that review, and enter a reason. Managers cannot use this endpoint. This action approves client KYC only; it does not grant IB approval or initiate a financial transaction.

The user flag and permanent KycReview record commit in one MongoDB transaction. The record includes the reviewer, reason, timestamp and original provider outcome. Review details are not exposed in client profile responses. The current provider session revision prevents stale reviews from overwriting concurrent decisions.

Veriff's original outcome stays intact. A later webhook for the same session preserves the owner's explicit decision. Manually rejected clients cannot discard the review by starting another verification. UAE eligibility exclusions, email verification, duplicate-mobile checks and live submitted-document requirements remain enforced.

No customer was approved during implementation or testing. Tests use synthetic records, a fake mail transport and rollback simulation. Production transaction availability and collection creation must succeed before a real review is committed; storage errors return a failure without confirming approval.
