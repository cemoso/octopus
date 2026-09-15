import { createHash } from "node:crypto";

export const MARKETING_RECEIVER = "https://ads.weezboo.com/api/conversion-events";
const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MarketingConfig {
  sourceId: string;
  environment: "test" | "live";
  serverKey: string;
  from: Date;
}

type EventBase = { schemaVersion: 1; eventId: string; occurredAt: string };
export type PurchaseKind = "top_up" | "subscription_initial" | "subscription_renewal" | "auto_reload" | "other_sale";
export type PurchaseEvent = EventBase & {
  eventType: "purchase";
  transactionId: string;
  customerId: string;
  amountMinor: string;
  currency: "GBP" | "USD";
  purchaseKind: PurchaseKind;
};
export type ConversionEvent = PurchaseEvent | (EventBase & {
  eventType: "registration";
  subjectId: string;
}) | (EventBase & {
  eventType: "refund";
  transactionId: string;
  originalTransactionId: string;
  customerId: string;
  amountMinor: string;
  currency: "GBP" | "USD";
});

/** No identifiers originating in a customer's browser are accepted here. */
export function conversionId(kind: string, opaqueId: string): string {
  if (!opaqueId || !/^[a-z_]+$/.test(kind)) throw new Error("Invalid conversion identity");
  return `${kind}_${createHash("sha256").update(`octopus-conversion-v1\n${kind}\n${opaqueId}`).digest("hex")}`;
}

export function registrationEvent(userId: string, createdAt: Date): ConversionEvent {
  return {
    schemaVersion: 1,
    eventId: conversionId("registration", userId),
    eventType: "registration",
    subjectId: conversionId("user", userId),
    occurredAt: createdAt.toISOString(),
  };
}

export function resolveMarketingConfig(env: Record<string, string | undefined>): MarketingConfig | null {
  if (!env.UNIFIED_ADS_ENABLED || env.UNIFIED_ADS_ENABLED === "false") return null;
  if (env.UNIFIED_ADS_ENABLED !== "true") throw new Error("UNIFIED_ADS_ENABLED must be true or false");
  if (env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED === "true" || env.OCTOPUS_SELF_HOSTED === "true") {
    throw new Error("Unified Ads collection is only supported for the hosted application");
  }
  const sourceId = env.UNIFIED_ADS_SOURCE_ID ?? "";
  const environment = env.UNIFIED_ADS_ENVIRONMENT;
  const serverKey = env.UNIFIED_ADS_SERVER_KEY ?? "";
  const rawFrom = env.UNIFIED_ADS_FROM ?? "";
  const normalizedFrom = rawFrom.replace(/(?<=:\d{2})Z$/, ".000Z");
  const from = new Date(normalizedFrom);
  if (!UUID.test(sourceId)) throw new Error("UNIFIED_ADS_SOURCE_ID must be a source UUID");
  if (environment !== "test" && environment !== "live") throw new Error("UNIFIED_ADS_ENVIRONMENT must be test or live");
  if (!/^uads_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(serverKey)) throw new Error("UNIFIED_ADS_SERVER_KEY is missing or invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalizedFrom) || !Number.isFinite(from.getTime()) || from.toISOString() !== normalizedFrom) {
    throw new Error("UNIFIED_ADS_FROM must be an explicit UTC timestamp");
  }
  return { sourceId, environment, serverKey, from };
}

export function serializeConversion(event: ConversionEvent): string {
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("Conversion exceeds receiver body limit");
  return body;
}

export type DeliveryResult =
  | { kind: "delivered"; status: number; receiptId: string }
  | { kind: "retry" | "blocked"; code: string; status?: number; retryAfterMs?: number };

export function retryDelayMs(attempt: number, retryAfterMs = 0): number {
  const exponential = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 7));
  return Math.max(exponential, Math.min(Math.max(retryAfterMs, 0), 24 * 60 * 60_000));
}

function retryAfter(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, 24 * 60 * 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 24 * 60 * 60_000)) : 0;
}

async function readReceipt(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing receipt");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("Receipt exceeds limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Takes already persisted bytes. A retry never reconstructs a business event. */
export async function deliverConversion(
  config: MarketingConfig,
  body: string,
  send: (request: Request) => Promise<Response> = (request) => fetch(request),
  timeoutMs = 10_000,
): Promise<DeliveryResult> {
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { kind: "blocked", code: "payload_too_large" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async (): Promise<DeliveryResult> => {
      const response = await send(new Request(MARKETING_RECEIVER, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.serverKey}` },
        body,
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      }));
      const status = response.status;
      if (status !== 200 && status !== 201) {
        await response.body?.cancel().catch(() => {});
        return {
          kind: status === 401 || status === 408 || status === 429 || status >= 500 ? "retry" : "blocked",
          code: status === 409 ? "receiver_conflict" : `receiver_http_${status}`,
          status,
          retryAfterMs: retryAfter(response.headers.get("retry-after")),
        };
      }
      try {
        const value = await readReceipt(response) as Record<string, unknown> | null;
        if (!value || value.status !== "stored" || value.attribution !== "not_established" || value.duplicate !== (status === 200) || typeof value.receiptId !== "string" || !UUID.test(value.receiptId)) {
          throw new Error("Invalid receipt");
        }
        return { kind: "delivered", status, receiptId: value.receiptId };
      } catch {
        return { kind: "retry", code: "receiver_invalid_receipt", status };
      }
    })()]);
  } catch {
    // Neither exception strings nor response bodies are safe diagnostics.
    return { kind: "retry", code: controller.signal.aborted ? "receiver_timeout" : "receiver_network" };
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
