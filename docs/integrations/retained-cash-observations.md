# Retained cash observations (operator candidate)

This additive inspection feature records what the retained credit ledger and cash outbox support at one producer database snapshot. It never calls Stripe, capture, resolution, retry or dispatch to fill missing facts. A migration is required: `20260922140000_marketing_cash_observations`. Deployment, migration rollout and any real observation require separate operational coordination; this candidate does not enable a scheduled job.

## Setup expectation

Keep the existing hosted marketing source/key/activation configuration. Additionally supply server-only `UNIFIED_ADS_CASH_EXPECTED_BINDING` as JSON with exact keys:

```
{sourceId, environment, keyId, capabilities, project: {projectId, version}}
```

Values must come from independently retained owner setup, not comparison output. Project ID is a UUID, version a positive integer, capabilities the exact configured set including purchases/refunds. No default project/version exists. TEST needs its own expectation, never a LIVE binding. The key ID must match the configured source key; no key secret is placed in the expectation or observation. Changed binding blocks comparison. This configuration is not added automatically by deployment.

## Operator operations

The existing internal admin authorization protects `POST /api/admin/marketing/cash-observations`. JSON only, no query, bounded 2KiB body, no-store responses. Exact request variants:

- `{"operation":"snapshot","from":"2026-09-20T00:00:00.000Z","to":"2026-09-21T00:00:00.000Z","predecessor":null}`: create one inventory. Interval is half-open and cannot end in the future. A predecessor inventory must have identical binding, activation and interval; the new document references its digest, never rewrites it.
- `{"operation":"read","id":"observation UUID"}`: read a source/environment-scoped immutable observation.
- `{"operation":"compare","id":"inventory UUID"}`: compare declared canonical members, then append comparison evidence linked to that exact inventory digest. It cannot repair an outbox row, ingest/replay an event or change a credit balance.

Identifiers in examples are illustrative, not authorization to make real calls. Operator responses include internal retained ledger/outbox provenance: keep them private. Errors are generic, without payloads/credentials/provider diagnostics.

Inventory is persisted inside the same repeatable-read transaction as its data reads. It includes at most 1,000 eligible ledger facts, 1,000 post-activation outbox rows and 1,000 exact-original candidates. Limit+1 probes flag truncation; truncated evidence is incomplete. Documents above 4MiB are rejected rather than silently shortened. Ledger eligibility is shared with normal capture: createdAt at/after existing activation, with an individual refund reference or a purchase/auto_reload/subscription type plus Stripe payment reference. No advance cursor is introduced. All eligible retained facts are inspected so unresolved business times cannot disappear through an interval filter.

Valid persisted original bytes yield normalized semantic projections; raw bytes remain unchanged. Equal canonical CS/PI aliases retain their origins but count once. Content/receipt/scope conflicts, missing capture, null/invalid payloads, unsupported references, unaccounted retained origins, pending/processing/blocked delivery and missing exact originals keep the scoped result incomplete. Cash occurredAt, ledger/outbox creation, producer observation and receiver batch intervals remain distinct. Current state is retained, not reconstructed attempt history. A pending row can have an uncertain receiver acknowledgment; no absence inference is made.

A genuine eligible in-range refund can require its exact original payment before activation. It remains an explicitly tagged dependency at its original timestamp, not new-period revenue and not permission to sweep old payments. Retained credit ledger coverage is not processor coverage; deletion or unsupported upstream paths cannot be recovered by this feature. Aggregate refund accounting/net revenue remains receiver-owned and is not certified by receipt matches.

## Results

- A: `not_observed`, `no_declared_members`, `declared_members_matched`, or `incomplete`. Comparison uses batches of at most32 with same-key identity preflight each time, fixed HTTPS destination, no redirects/Origin/Cookie and strict ordered responses/project binding. It retains actual request/response digests and separate receiver intervals. There is no atomic whole-set receiver snapshot.
- B: `complete_retained_scope` only when the bounded retained snapshot has no accounting gaps; otherwise `incomplete`. An all-matched declared set can coexist with incomplete B. It is not a claim of all cash ever collected.
- C: always `unknown` for upstream completeness.

No customer-zero label, advertising assignment, learning eligibility or model admission is emitted. Empty declared membership is not positive A. A lost-ACK match is evidence only: pending outbox status is unchanged. Late facts require a successor inventory; old results remain historical observations and must not be used as current completeness after contrary evidence. Comparison documents are append-only; later comparisons do not edit prior ones. The database rejects observation UPDATE/DELETE; this is not a guarantee against database-owner privilege or retention loss outside the supported application.

## Validation and limits

The copied immutable receiver vector packet has SHA-256 `042947da07da8014506e0926c2ef35a129b31f85bbd8e0667bd13a8839c23585`; all21 valid projections and10 rejections are exercised. Isolated PostgreSQL tests run normal capture/dispatch then the real snapshot/persistence path, check successor/immutability, and distinguish all-matched A from missing-capture B. Comparison transport injections are component evidence only. Full new retained-inventory → isolated actual receiver acceptance requires a newly coordinated receiver-owned fixture; prior destroyed protocol fixtures are not reused.

Run pure tests with `bun test apps/web/lib/__tests__/marketing-cash-observation.test.ts`. Run DB tests with `RUN_MARKETING_DB_TESTS=1 DATABASE_URL=<local dedicated test DB> bun test apps/web/lib/__tests__/marketing-outbox.db.test.ts`; they create/drop only their owned random database. No LIVE/provider access is needed or permitted for candidate validation.
