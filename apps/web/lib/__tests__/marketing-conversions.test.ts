import { describe, expect, it } from "bun:test";
import {
  conversionId,
  deliverConversion,
  registrationEvent,
  resolveMarketingConfig,
  retryDelayMs,
  serializeConversion,
} from "../marketing-conversions";

const sourceId = "dc4e0e00-721d-4e27-ae92-0ca40e23ead9";
const key = `uads_${sourceId}_${"x".repeat(43)}`;
const config = { sourceId, environment: "test" as const, serverKey: key, from: new Date("2026-09-09T00:00:00Z") };
const event = registrationEvent("opaque-user", new Date("2026-09-15T12:00:00Z"));
const receiptId = "eb5a06a6-a7d1-4dfe-b2aa-b9f1c93c8db0";

describe("Unified Ads business events", () => {
  it("uses stable opaque registration identities and the actual creation time", () => {
    expect(event).toEqual({ schemaVersion: 1, eventId: conversionId("registration", "opaque-user"), eventType: "registration", subjectId: conversionId("user", "opaque-user"), occurredAt: "2026-09-15T12:00:00.000Z" });
    expect(JSON.stringify(event)).not.toContain("opaque-user");
    expect(registrationEvent("opaque-user", new Date(event.occurredAt))).toEqual(event);
  });

  it("is opt-in and refuses self-hosted collection", () => {
    expect(resolveMarketingConfig({})).toBeNull();
    expect(resolveMarketingConfig({ UNIFIED_ADS_ENABLED: "false" })).toBeNull();
    expect(() => resolveMarketingConfig({ UNIFIED_ADS_ENABLED: "true" })).toThrow();
    expect(() => resolveMarketingConfig({ UNIFIED_ADS_ENABLED: "true", NEXT_PUBLIC_OCTOPUS_SELF_HOSTED: "true" })).toThrow();
    expect(() => resolveMarketingConfig({ UNIFIED_ADS_ENABLED: "true", OCTOPUS_SELF_HOSTED: "true" })).toThrow();
  });

  it("requires an explicit source environment, source ID, server key and collection cutoff", () => {
    const env = { UNIFIED_ADS_ENABLED: "true", UNIFIED_ADS_SOURCE_ID: sourceId, UNIFIED_ADS_ENVIRONMENT: "test", UNIFIED_ADS_SERVER_KEY: key, UNIFIED_ADS_FROM: "2026-09-09T00:00:00Z" };
    expect(resolveMarketingConfig(env)).toEqual(config);
    for (const field of Object.keys(env).filter(k => k !== "UNIFIED_ADS_ENABLED")) {
      expect(() => resolveMarketingConfig({ ...env, [field]: "" })).toThrow();
    }
    expect(() => resolveMarketingConfig({ ...env, UNIFIED_ADS_FROM: "2026-02-31T00:00:00Z" })).toThrow();
  });

  it("sends the persisted body to the fixed HTTPS receiver with no browser context", async () => {
    const body = serializeConversion(event);
    const calls: Request[] = [];
    const result = await deliverConversion(config, body, async (request) => {
      calls.push(request);
      return Response.json({ receiptId, duplicate: false, status: "stored", attribution: "not_established" }, { status: 201 });
    });
    expect(result).toEqual({ kind: "delivered", receiptId, status: 201 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ads.weezboo.com/api/conversion-events");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.redirect).toBe("error");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(calls[0]!.headers.has("origin")).toBe(false);
    expect(calls[0]!.headers.has("cookie")).toBe(false);
    expect(await calls[0]!.text()).toBe(body);
  });

  it("accepts a genuine duplicate receipt but refuses malformed success", async () => {
    const body = serializeConversion(event);
    expect(await deliverConversion(config, body, async () => Response.json({ receiptId, duplicate: true, status: "stored", attribution: "not_established" }))).toEqual({ kind: "delivered", receiptId, status: 200 });
    for (const value of [{}, { receiptId, duplicate: false, status: "stored", attribution: "not_established" }, { receiptId, duplicate: true, status: "queued" }]) {
      expect((await deliverConversion(config, body, async () => Response.json(value))).kind).toBe("retry");
    }
  });

  it("keeps uncertain delivery retryable and never exposes receiver errors", async () => {
    const body = serializeConversion(event);
    for (const status of [401, 408, 429, 500, 502, 503]) {
      const result = await deliverConversion(config, body, async () => new Response("private receiver body", { status, headers: { "Retry-After": "120" } }));
      expect(result).toMatchObject({ kind: "retry", status, retryAfterMs: 120_000 });
      expect(JSON.stringify(result)).not.toContain("private");
    }
    const result = await deliverConversion(config, body, async () => { throw new Error(key); });
    expect(result).toMatchObject({ kind: "retry", code: "receiver_network" });
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("blocks conflicts and configuration/body rejection without inventing new IDs", async () => {
    for (const status of [301, 400, 403, 404, 409, 413, 415]) {
      expect(await deliverConversion(config, serializeConversion(event), async () => new Response("", { status }))).toMatchObject({ kind: "blocked", status });
    }
  });

  it("bounds both outbound and inbound bodies", async () => {
    let calls = 0;
    expect(await deliverConversion(config, "x".repeat(16_385), async () => { calls++; return new Response(); })).toMatchObject({ kind: "blocked", code: "payload_too_large" });
    expect(calls).toBe(0);
    expect(await deliverConversion(config, serializeConversion(event), async () => new Response("x".repeat(16_385), { status: 201 }))).toMatchObject({ kind: "retry", code: "receiver_invalid_receipt" });
  });

  it("bounds stalled HTTP and response-body reads with the same deadline", async () => {
    const body = serializeConversion(event);
    let signal: AbortSignal | undefined;
    expect(await deliverConversion(config, body, async request => {
      signal = request.signal;
      return new Promise<Response>(() => {});
    }, 20)).toMatchObject({ kind: "retry", code: "receiver_timeout" });
    expect(signal?.aborted).toBe(true);
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    expect(await deliverConversion(config, body, async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { status: 201 }), 20)).toMatchObject({ kind: "retry", code: "receiver_timeout" });
    stream?.close();
  });

  it("backs off without dropping identity and caps excessive Retry-After", async () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(100)).toBe(3_600_000);
    const result = await deliverConversion(config, serializeConversion(event), async () => new Response("", { status: 429, headers: { "retry-after": "999999999999999999999" } }));
    expect(result).toMatchObject({ kind: "retry", retryAfterMs: 86_400_000 });
    if (result.kind !== "delivered") expect(retryDelayMs(1, result.retryAfterMs)).toBe(86_400_000);
  });
});
