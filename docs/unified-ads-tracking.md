# Unified Ads tracking producer

Status: delivery foundation only. Browser collection, consent controls and verified
registration/checkout associations are not installed by this change. LIVE
tracking must remain disabled. Existing business-event delivery continues.

Receiver contract: `docs/conversion-tracking.md` in Unified Ads. This producer
uses its separate `/api/conversion-tracking/identity` and
`/api/conversion-tracking` endpoints. It does not forward conversions to ad
networks or report profit. Net cash/ROAS does not deduct AI costs or payment fees.
Profit reporting requires agreed cost semantics and receiver support.

## Delivery foundation

Apply additive migration `20260917100000_marketing_tracking_outbox` before using
tracking records. It adds `visit` and `conversion_context` kinds to the existing
marketing outbox and requires non-null payloads no larger than 4,096 bytes. No
existing business-event identities, bytes or billing tables are changed.

The internal `enqueueMarketingTracking` function accepts an already verified
record from a server-side capture path. It is not a browser endpoint and does
not validate campaign-link membership or establish consent by itself. Its caller
must establish those facts first. Exact retries reuse the saved event ID and
bytes; conflicting bytes for that ID are rejected. Existing row leases, stale
worker fencing, receipts and bounded retry delays also apply to tracking.

Every attempt checks the authenticated receiver's exact source, environment,
tracking enrollment, project, origin, model and record types with the same key
as the subsequent POST. A mismatch produces zero POST. Tracking receipts must
match that source/environment/enrollment. Business events retain their separate
preflight and receipt validation. Both use the existing bounded HTTP transport.

Tracking configuration is additional to the existing
[business-event configuration](unified-ads-conversions.md#configuration-and-activation):

- `UNIFIED_ADS_TRACKING_ENABLED`: defaults to off.
- `UNIFIED_ADS_TRACKING_ID`: receiver-provisioned enrollment UUID.
- `UNIFIED_ADS_PROJECT_ID`: receiver-provisioned project UUID.
- `UNIFIED_ADS_TRACKING_ORIGIN`: `https://octopus-review.ai`.
- `UNIFIED_ADS_TRACKING_FROM`: explicit UTC new-events cutoff, no earlier than
  the business-event cutoff. Do not advance it to discard pending records.

Wrong or disabled tracking configuration leaves tracking rows unsent. It does
not disable the business-event worker; the shared
[claim priority and budgets](unified-ads-conversions.md#durable-delivery) protect
business delivery from a tracking backlog. Self-hosted collection remains refused.
Keep the additive migration when rolling back code; disable tracking and drain
or hold tracking rows before running an older worker that does not recognize
these kinds. Tests apply migrations only in a disposable test database and do
not activate production tracking.

## Remaining capture and acceptance gates

1. Separate analytics/attribution consent, withdrawal and clearing browser state.
   Current unconditional analytics/pixel loading must be addressed with that UI.
2. A bounded same-origin capture endpoint with random source-scoped browser/session
   identifiers and server-owned occurrence timestamps, after explicit activation.
3. Receiver-supported campaign-link enrollment prevalidation. The current receiver
   exposes bearer identity and ingestion; campaign setup listing requires a human
   workspace session. A supported source-key validation mechanism has been
   requested from the receiver owner. Never substitute browser campaign/account
   IDs, an invented endpoint or a copied human session.
4. Persist the verified initiating visitor at account creation and payment
   initiation. Include hosted Checkout and direct saved-card purchase/subscription
   starts. Carry the association to the exact existing registration subject or
   canonical successful payment ID and timestamp. Do not infer a renewal's visitor
   from a later session or organisation membership.
5. Exercise the actual capture/outbox/dispatcher against TEST, including tagged
   and organic visits, withdrawal, purchases, individual refunds, ordering,
   lost-response recovery and identity/tenant rejection. Transport component
   acceptance alone does not establish browser or paid-attribution acceptance.
6. Obtain receiver corroboration, pass normal review/CI, then agree the LIVE
   enrollment and explicit activation cutoff with the receiver owner. No campaign
   changes or synthetic LIVE records.

## Checks

```sh
bun test apps/web/lib/__tests__/marketing-tracking.test.ts apps/web/lib/__tests__/marketing-conversions.test.ts apps/web/lib/__tests__/marketing-stripe.test.ts
RUN_MARKETING_DB_TESTS=1 bun test apps/web/lib/__tests__/marketing-outbox.db.test.ts
```

The database test requires a disposable local test database as described in
[the business-event integration](unified-ads-conversions.md#validation). It
applies both real migrations and proves tracking immutability, retry recovery,
source/enrollment fencing and continuing business delivery ahead of an older
tracking backlog with tracking disabled, invalid configuration or a valid but
incorrect project UUID.
No normal test calls the external receiver.
