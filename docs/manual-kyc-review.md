# Owner manual KYC review

In Users, owners can record an independent approval after checking an original photo ID and matching it to the client. The review records the document issuing country, internal evidence reference, reviewer, date and reason. This source works before a Veriff session or decision exists. The owner can also record a rejection of a previous independent approval. The verified account, residence, UAE restrictions and unique-mobile checks apply to approval.

Owners can also review a submitted live Veriff case using the submitted documents and provider result. Veriff-based approval still reconsiders an existing IB application under the established eligibility rules. Independent approval applies to client KYC. The existing opt-in live identity check remains available for an IB application.

The user flag and permanent KycReview record commit in one MongoDB transaction. The record includes the reviewer, reason, timestamp and original provider outcome. Review details are not exposed in client profile responses. The current provider session revision prevents stale reviews from overwriting concurrent decisions.

The review source and any linked Veriff outcome are stored separately. A later signed callback preserves an active owner decision. Manually rejected clients must contact support for further review. For independent review, the client ID and reviewed account timestamp protect against stale submissions.

No customer was approved during implementation or testing. Tests use synthetic records, a fake mail transport and rollback simulation. Production transaction availability and collection creation must succeed before a real review is committed; storage errors return a failure without confirming approval.

KYC and IB use separate transactions. If the IB update fails after the review is saved, the response confirms KYC and reports `ibStatus=update_required`; the owner can retry from IB using **Approve using verified KYC**. Notification failure does not undo either committed decision.
