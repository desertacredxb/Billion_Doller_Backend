# Duplicate deposit-credit protection — 21 October 2026

## Owner's final scope

Keep exactly three existing options: RameePay INR, RameePay Crypto and Cregis Crypto. DigiPay and TrustPay24 are closed. The unused TruePay9 callback is disabled as only those three options remain enabled. Closed deposit/callback handlers return HTTP 410 without loading provider credentials or invoking financial services. Reconciliation skips closed providers, retaining old records for owner review. The frontend removes TrustPay24 and keeps the three existing supported components.

The security change is limited to preventing repeated credits. Existing active provider URLs, credentials, payload/encryption formats, exchange-rate/conversion rules, payment charges, minimums, KYC and Cregis partial/top-up calculations are preserved. Callback-signature/provider-authentication behavior was not redesigned or certified.

## Shared credit claim

RameePay INR, RameePay Crypto and Cregis callbacks and the pending-order reconciliation job all use the same persistent Order claim before reading payment state and calculating a credit. The claim and the pre-MT5 submission marker use majority/journaled writes. An existing full unique orderid index is verified at startup and before the first credit in each guard instance; missing/partial uniqueness prevents financial processing.

Only one callback/reconciliation worker can process an order at a time. Successful legacy orders are never recredited even if they predate creditedAmount. Cregis partial payments and top-ups read the newly claimed cumulative credit before computing the existing delta. Each invocation may submit at most one positive balance credit to the saved account. MT5's accepted zero response formats are normalized for existing controllers.

A timeout or interrupted process can mean MT5 applied a credit but its reply was lost. The claim is therefore never automatically expired after submission. If a balance call fails ambiguously or the subsequent order save fails, the order remains locked for review. A successful committed status, credited amount and MT5 ticket are saved before the claim is released. Claims prevent automated duplicate attempts; this is not a distributed transaction or a guarantee that every external-provider outcome is automatically reconciled.

## Manual reconciliation

For settlementAttempt states processing/submitting/review, compare the saved delta/target, provider receipt and MT5 deal history for the account, timestamp, order comment and ticket. Determine whether a credit actually happened before repairing the order and releasing the exact claim using normal authorized database operations. Do not clear a claim merely because it is old or retry a balance call to see what happens. No production claim was cleared during testing.

## Validation

Tests use mocked storage and MT5. They cover repeated callbacks, simultaneous callback/reconciliation, Cregis partial/top-up sequences, lost replies, failed post-credit saves, restarted workers, required unique indexes, invalid/account-mismatched balance calls and two credit attempts within one callback. Each retained callback controller is exercised twice and produces exactly one mocked credit. Closed gateway handlers return 410. No real payment, account, callback, withdrawal, refund or email was created by these tests.

Other payment-authentication issues from the earlier review remain outside this narrowed duplicate-credit change. Do not describe this as a complete certification of all gateway security.

## Crypto callback acknowledgements — 25 October 2026

RameePay Crypto and Cregis deposit replies now wait for the shared guard's final majority/journaled settlement write. A lost MT5 reply, unsuccessful MT5 result, failed order save, unresolved claim or failed final write returns a non-success response. Pending/review claims remain locked; redelivery never automatically repeats an ambiguous balance adjustment. Reconciliation must establish the provider/MT5 outcome first. Cregis payout storage failures and malformed notifications no longer receive a success acknowledgement.

Successful Cregis callbacks return HTTP 200 and exactly `success` as `text/plain`. Its Payment Engine documentation states that other responses fail the notification and can be manually retried from the portal; do not promise automatic redelivery. RameePay Crypto processing failures return HTTP 503 with success:false; its automatic retry cadence is not certified. RameePay INR, gateway configuration, conversion calculations, payout/refund decisions and sender-authentication contracts are unchanged.

Source: https://developers.cregis.com/en/reference/payment-engine-api/orderCallback/

Regression checks use isolated models and MT5 stubs, including response timing, timeout/rejection, repeated delivery, final-write failure and failed payout persistence. No live callback, payment, refund or historical replay is used to validate this change.
