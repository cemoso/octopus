import "server-only";
import { randomUUID } from "node:crypto";
import { prisma, type MarketingConversion } from "@octopus/db";
import { getStripe } from "./stripe";
import {
  deliverConversion,
  registrationEvent,
  resolveMarketingConfig,
  retryDelayMs,
  serializeConversion,
  type DeliveryResult,
  type MarketingConfig,
} from "./marketing-conversions";
import { MarketingSourceError, marketingStripeReader, resolveStripeConversion, type MarketingStripeReader } from "./marketing-stripe";

const CAPTURE_BATCH = 100;
const LEASE_MS = 120_000;
const TICK_MS = 90_000;
const DELIVERY_BATCH = 20;

/** Reconcile committed facts, not hook callbacks or an unsafe commit-time cursor. */
export async function captureMarketingConversions(config: MarketingConfig): Promise<number> {
  const mismatched = await prisma.marketingConversion.findFirst({ where: { sourceId: config.sourceId, environment: { not: config.environment } }, select: { id: true } });
  if (mismatched) throw new MarketingSourceError("source_environment_mismatch");
  const [users, financial] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>`
      SELECT u.id, u."createdAt" FROM users u
      WHERE u."createdAt" >= ${config.from}
        AND NOT EXISTS (SELECT 1 FROM marketing_conversions o
          WHERE o."sourceId" = ${config.sourceId} AND o."originKey" = 'registration:' || u.id)
      ORDER BY u."createdAt", u.id LIMIT ${CAPTURE_BATCH}`,
    prisma.$queryRaw<Array<{ id: string; createdAt: Date; organizationId: string; stripeSessionId: string | null; stripeRefundId: string | null }>>`
      SELECT c.id, c."createdAt", c."organizationId", c."stripeSessionId", c."stripeRefundId"
      FROM credit_transactions c
      WHERE c."createdAt" >= ${config.from}
        AND (c."stripeRefundId" IS NOT NULL OR (c.type IN ('purchase', 'auto_reload', 'subscription') AND c."stripeSessionId" IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM marketing_conversions o
          WHERE o."sourceId" = ${config.sourceId} AND o."originKey" = 'ledger:' || c.id)
      ORDER BY c."createdAt", c.id LIMIT ${CAPTURE_BATCH}`,
  ]);
  const rows = [
    ...users.map(user => ({ sourceId: config.sourceId, environment: config.environment, originKey: `registration:${user.id}`, kind: "registration", reference: user.id, sourceCreatedAt: user.createdAt, organizationId: null, payload: serializeConversion(registrationEvent(user.id, user.createdAt)) })),
    ...financial.map(row => ({ sourceId: config.sourceId, environment: config.environment, originKey: `ledger:${row.id}`, kind: row.stripeRefundId ? "refund" : "purchase", reference: (row.stripeRefundId ?? row.stripeSessionId)!, organizationId: row.organizationId, sourceCreatedAt: row.createdAt, payload: null })),
  ];
  if (!rows.length) return 0;
  return (await prisma.marketingConversion.createMany({ data: rows, skipDuplicates: true })).count;
}

export async function claimMarketingConversion(config: MarketingConfig, now = new Date()): Promise<MarketingConversion | null> {
  const leaseId = randomUUID();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const rows = await prisma.$queryRaw<MarketingConversion[]>`
    WITH candidate AS (
      SELECT id FROM marketing_conversions
      WHERE "sourceId" = ${config.sourceId} AND environment = ${config.environment}
        AND ((status = 'pending' AND "nextAttemptAt" <= ${now}) OR (status = 'processing' AND "leaseUntil" <= ${now}))
      ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE marketing_conversions o
    SET status = 'processing', "leaseId" = ${leaseId}, "leaseUntil" = ${leaseUntil},
        attempts = attempts + 1, "updatedAt" = ${now}
    FROM candidate WHERE o.id = candidate.id RETURNING o.*`;
  return rows[0] ?? null;
}

/** Fences a late result from a worker whose lease expired or was reclaimed. */
export async function finishMarketingConversion(row: MarketingConversion, result: DeliveryResult, now = new Date()): Promise<boolean> {
  const data = result.kind === "delivered"
    ? { status: "delivered", receiptId: result.receiptId, httpStatus: result.status, deliveredAt: now, errorCode: null }
    : { status: result.kind === "blocked" ? "blocked" : "pending", httpStatus: result.status ?? null, errorCode: result.code, nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts, result.retryAfterMs)) };
  const updated = await prisma.marketingConversion.updateMany({
    where: { id: row.id, status: "processing", leaseId: row.leaseId, leaseUntil: { gt: now } },
    data: { ...data, leaseId: null, leaseUntil: null },
  });
  return updated.count === 1;
}

async function persistedBody(row: MarketingConversion, config: MarketingConfig, reader?: MarketingStripeReader): Promise<string | null> {
  if (row.payload !== null) return row.payload;
  let body: string;
  let original: Awaited<ReturnType<typeof resolveStripeConversion>>["originalPurchase"];
  if (row.kind === "registration") {
    body = serializeConversion(registrationEvent(row.reference, row.sourceCreatedAt));
  } else {
    if ((row.kind !== "purchase" && row.kind !== "refund") || !row.organizationId) throw new MarketingSourceError("invalid_outbox_source");
    const resolved = await resolveStripeConversion(reader ?? marketingStripeReader(getStripe()), row.kind, row.reference, row.organizationId, config.environment);
    body = serializeConversion(resolved.event);
    original = resolved.originalPurchase;
  }
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const updated = await tx.marketingConversion.updateMany({
      where: { id: row.id, status: "processing", leaseId: row.leaseId, leaseUntil: { gt: now }, payload: null },
      data: { payload: body },
    });
    if (updated.count !== 1) return null;
    if (original) {
      // A refund may be inside the collection window while its payment is
      // outside it. Preserve the real original, never invent a zero purchase.
      const originalBody = serializeConversion(original.event);
      const originKey = `payment:${original.paymentIntentId}`;
      const dependency = await tx.marketingConversion.upsert({
        where: { sourceId_originKey: { sourceId: config.sourceId, originKey } },
        create: { sourceId: config.sourceId, environment: config.environment, originKey, kind: "purchase", reference: original.paymentIntentId, organizationId: row.organizationId, sourceCreatedAt: new Date(original.event.occurredAt), payload: originalBody },
        update: {},
      });
      if (dependency.payload !== originalBody || dependency.environment !== config.environment) throw new MarketingSourceError("original_payment_conflict");
    }
    return body;
  });
}

export async function processMarketingConversion(
  row: MarketingConversion,
  config: MarketingConfig,
  reader?: MarketingStripeReader,
  send?: (request: Request) => Promise<Response>,
): Promise<"delivered" | "retry" | "blocked" | "lease_lost"> {
  if (row.sourceId !== config.sourceId || row.environment !== config.environment) throw new MarketingSourceError("outbox_source_mismatch");
  let result: DeliveryResult;
  try {
    const body = await persistedBody(row, config, reader);
    if (body === null) return "lease_lost";
    const owned = await prisma.marketingConversion.count({ where: { id: row.id, leaseId: row.leaseId, status: "processing", leaseUntil: { gt: new Date() } } });
    if (!owned) return "lease_lost";
    result = await deliverConversion(config, body, send);
  } catch (error) {
    if (error instanceof MarketingSourceError) {
      result = { kind: error.retryable ? "retry" : "blocked", code: error.code };
    } else {
      const missing = typeof error === "object" && error !== null && "code" in error && error.code === "resource_missing";
      result = { kind: missing ? "blocked" : "retry", code: missing ? "stripe_reference_missing" : "source_unavailable" };
    }
  }
  if (!await finishMarketingConversion(row, result)) return "lease_lost";
  return result.kind;
}

export async function syncMarketingConversions(): Promise<void> {
  const config = resolveMarketingConfig(process.env);
  if (!config) return;
  if (config.environment !== "live" && process.env.NODE_ENV === "production") throw new MarketingSourceError("production_requires_live_source");
  const captured = await captureMarketingConversions(config);
  const deadline = Date.now() + TICK_MS;
  const counts = { delivered: 0, retry: 0, blocked: 0, lease_lost: 0 };
  for (let processed = 0; processed < DELIVERY_BATCH && Date.now() < deadline; processed++) {
    const row = await claimMarketingConversion(config);
    if (!row) break;
    counts[await processMarketingConversion(row, config)]++;
  }
  // Counts only: no source references, Stripe objects, bearer keys or bodies.
  console.log("[marketing-conversions]", { captured, ...counts });
}
