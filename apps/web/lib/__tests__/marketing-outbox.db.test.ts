import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { conversionId, type MarketingConfig } from "../marketing-conversions";
import { trackingIdentity, TRACKING_MODEL, type TrackingConfig } from "../marketing-tracking";
import { fixture } from "./fixtures/marketing-stripe";

const enabled = process.env.RUN_MARKETING_DB_TESTS === "1";
const originalUrl = process.env.DATABASE_URL;
const databaseName = `marketing_test_${randomUUID().replaceAll("-", "")}`;
const config: MarketingConfig = { sourceId: randomUUID(), environment: "test", serverKey: "synthetic-test-key", from: new Date("2026-09-09T00:00:00Z") };
const receiptId = randomUUID();
let admin: Client;
let db: Client;
let prisma: (typeof import("@octopus/db"))["prisma"];
let outbox: typeof import("../marketing-outbox");
let created = false;
let testUrl: string;
const received = (duplicate = false) => new Response(JSON.stringify({ receiptId, duplicate, status: "stored", attribution: "not_established" }), { status: duplicate ? 200 : 201 });
function withIdentity(send: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async request => request.method === "GET"
    ? Response.json({ schemaVersion: 1, sourceId: config.sourceId, environment: config.environment, keyId: receiptId, capabilities: ["registrations", "purchases", "refunds"] })
    : send(request);
}
async function user(id = "test_user", date = new Date()) {
  await db.query('INSERT INTO users (id, "createdAt") VALUES ($1, $2)', [id, date]);
}
async function ledger(id: string, type: string, payment: string | null, refund: string | null = null) {
  await db.query('INSERT INTO credit_transactions (id, "createdAt", "organizationId", type, "stripeSessionId", "stripeRefundId") VALUES ($1, NOW(), $2, $3, $4, $5)', [id, "org_fixture", type, payment, refund]);
}
async function due(id: string) {
  await prisma.marketingConversion.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
}

(enabled ? describe : describe.skip)("Unified Ads outbox with the actual PostgreSQL migration", () => {
  beforeAll(async () => {
    const url = new URL(originalUrl ?? "http://invalid");
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/(^|[-_])test($|[-_])/.test(url.pathname.slice(1))) {
      throw new Error("Marketing DB tests require a local dedicated test database");
    }
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    testUrl = url.toString();
    db = new Client({ connectionString: testUrl });
    await db.connect();
    // Minimal pre-migration source tables. All outbox DDL and constraints come
    // from the shipped SQL, rather than db push or a test copy of that schema.
    await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, "createdAt" TIMESTAMP(3) NOT NULL); CREATE TABLE credit_transactions (id TEXT PRIMARY KEY, "createdAt" TIMESTAMP(3) NOT NULL, "organizationId" TEXT NOT NULL, type TEXT NOT NULL, "stripeSessionId" TEXT, "stripeRefundId" TEXT)');
    await db.query(await readFile(new URL("../../../../packages/db/prisma/migrations/20260915140000_marketing_conversion_outbox/migration.sql", import.meta.url), "utf8"));
    await db.query(await readFile(new URL("../../../../packages/db/prisma/migrations/20260917100000_marketing_tracking_outbox/migration.sql", import.meta.url), "utf8"));
    process.env.DATABASE_URL = testUrl;
    mock.module("server-only", () => ({}));
    ({ prisma } = await import("@octopus/db"));
    outbox = await import("../marketing-outbox");
  });
  // DROP DATABASE can wait for a PostgreSQL checkpoint on shared CI storage.
  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin?.end();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }, 30_000);
  beforeEach(async () => {
    await db.query("TRUNCATE marketing_conversions, users, credit_transactions");
  });

  it("persists tracking bytes in the same outbox, recovers a lost response, and fences foreign bindings", async () => {
    const tracking: TrackingConfig = { ...config, trackingId: randomUUID(), projectId: randomUUID(), origin: "https://octopus-review.ai", trackingFrom: config.from };
    const body = JSON.stringify({ schemaVersion: 1, recordType: "visit", eventId: randomUUID(), trackingId: tracking.trackingId,
      occurredAt: new Date().toISOString(), visitorId: trackingIdentity("visitor", config.sourceId, randomUUID()),
      sessionId: trackingIdentity("session", config.sourceId, randomUUID()), origin: tracking.origin,
      analyticsConsent: "granted", attributionConsent: false, campaignLinkId: null });
    const id = await outbox.enqueueMarketingTracking(tracking, body);
    expect(await outbox.enqueueMarketingTracking(tracking, body)).toBe(id);
    await expect(outbox.enqueueMarketingTracking(tracking, body.replace('"attributionConsent":false', '"attributionConsent":true'))).rejects.toThrow("tracking_identity_conflict");
    await expect(Promise.resolve(prisma.marketingConversion.update({ where: { id }, data: { payload: "{}" } }))).rejects.toThrow();
    const identities: string[] = []; const bodies: string[] = [];
    const send = async (request: Request) => {
      identities.push(request.method);
      if (request.method === "GET") return Response.json({ schemaVersion: 1, sourceId: tracking.sourceId,
        environment: tracking.environment, keyId: receiptId, trackingId: tracking.trackingId,
        projectId: tracking.projectId, origin: tracking.origin, model: TRACKING_MODEL, recordTypes: ["visit", "conversion_context"] });
      bodies.push(await request.text());
      if (bodies.length === 1) throw new Error("lost successful response");
      return Response.json({ receiptId, duplicate: true, status: "stored", sourceId: tracking.sourceId, environment: tracking.environment, trackingId: tracking.trackingId });
    };
    let row = (await outbox.claimMarketingConversion(config))!;
    expect(await outbox.processMarketingConversion(row, config, undefined, send, tracking)).toBe("retry");
    await due(id);
    row = (await outbox.claimMarketingConversion(config))!;
    expect(await outbox.processMarketingConversion(row, config, undefined, send, tracking)).toBe("delivered");
    expect(bodies).toEqual([body, body]);
    expect(identities).toEqual(["GET", "POST", "GET", "POST"]);
    expect(await prisma.marketingConversion.findUniqueOrThrow({ where: { id } })).toMatchObject({ payload: body, receiptId, attempts: 2, status: "delivered" });
    const second = await outbox.enqueueMarketingTracking(tracking, body.replace(JSON.parse(body).eventId, randomUUID()));
    row = (await outbox.claimMarketingConversion(config))!;
    expect(row.id).toBe(second);
    expect(await outbox.processMarketingConversion(row, config, undefined, send, { ...tracking, trackingId: randomUUID() })).toBe("blocked");
    expect(identities).toHaveLength(4);
  });

  it("keeps disabled tracking pending while business events continue to deliver", async () => {
    const tracking: TrackingConfig = { ...config, trackingId: randomUUID(), projectId: randomUUID(), origin: "https://octopus-review.ai", trackingFrom: config.from };
    const id = await outbox.enqueueMarketingTracking(tracking, JSON.stringify({ schemaVersion: 1, recordType: "conversion_context", eventId: randomUUID(),
      trackingId: tracking.trackingId, occurredAt: new Date().toISOString(), visitorId: trackingIdentity("visitor", config.sourceId, randomUUID()),
      conversionType: "registration", conversionId: conversionId("user", "test_user"), attributionConsent: "granted" }));
    const trackingRow = (await outbox.claimMarketingConversion(config))!;
    let sends = 0;
    expect(await outbox.processMarketingConversion(trackingRow, config, undefined, async () => { sends++; throw Error(); })).toBe("retry");
    expect(sends).toBe(0);
    expect(await prisma.marketingConversion.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "pending", errorCode: "tracking_disabled" });
    await user(); await outbox.captureMarketingConversions(config);
    const businessRow = (await outbox.claimMarketingConversion(config))!;
    expect(businessRow.kind).toBe("registration");
    expect(await outbox.processMarketingConversion(businessRow, config, undefined, withIdentity(async () => received()))).toBe("delivered");
  });

  it("captures actual registrations and Stripe-linked cash facts, including usage-typed refunds", async () => {
    await user();
    await user("pre_cutoff", new Date("2026-09-08T00:00:00Z"));
    await ledger("payment", "purchase", "pi_fixture");
    await ledger("auto_reload", "auto_reload", "pi_other");
    await ledger("refund", "usage", null, "re_fixture");
    await ledger("ordinary_usage", "usage", null);
    await ledger("promotional_credit", "purchase", null);
    const captures = await Promise.all([outbox.captureMarketingConversions(config), outbox.captureMarketingConversions(config)]);
    expect(captures[0]! + captures[1]!).toBe(4);
    const rows = await prisma.marketingConversion.findMany();
    expect(rows.filter(row => row.kind === "refund")).toHaveLength(1);
    expect(rows.find(row => row.kind === "registration")?.payload).toContain(conversionId("user", "test_user"));
    expect(await outbox.captureMarketingConversions(config)).toBe(0);
  });

  it("delivers registrations and replays persisted cash without Stripe credentials in the scheduled worker", async () => {
    const env = {
      UNIFIED_ADS_ENABLED: "true", UNIFIED_ADS_SOURCE_ID: config.sourceId,
      UNIFIED_ADS_ENVIRONMENT: "test", UNIFIED_ADS_SERVER_KEY: `uads_${receiptId}_${"a".repeat(43)}`,
      UNIFIED_ADS_FROM: config.from.toISOString(), NODE_ENV: "test",
      OCTOPUS_SELF_HOSTED: "false", NEXT_PUBLIC_OCTOPUS_SELF_HOSTED: "false",
      STRIPE_SECRET_KEY: undefined,
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    const bodies: string[] = [];
    const send = spyOn(globalThis, "fetch").mockImplementation(withIdentity(async request => {
      bodies.push(await request.text());
      return received(true);
    }) as typeof fetch);
    try {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await ledger("payment", "subscription", "pi_fixture");
      await outbox.captureMarketingConversions(config);
      const payment = (await outbox.claimMarketingConversion(config))!;
      expect(await outbox.processMarketingConversion(payment, config, fixture().reader, withIdentity(async () => {
        throw new Error("receipt lost");
      }))).toBe("retry");
      const persisted = (await prisma.marketingConversion.findUniqueOrThrow({ where: { id: payment.id } })).payload!;
      await due(payment.id);
      await user();
      // An unresolved cash row must retry without starving independent delivery.
      await ledger("unresolved", "purchase", "pi_unresolved");
      await outbox.syncMarketingConversions();
      const rows = await prisma.marketingConversion.findMany();
      expect(rows.find(row => row.kind === "registration")).toMatchObject({ status: "delivered", receiptId, attempts: 1 });
      expect(rows.find(row => row.id === payment.id)).toMatchObject({ status: "delivered", receiptId, attempts: 2, payload: persisted });
      expect(rows.find(row => row.reference === "pi_unresolved")).toMatchObject({ status: "pending", errorCode: "source_unavailable", receiptId: null, payload: null });
      expect(bodies).toHaveLength(2);
      expect(bodies).toContain(persisted);
      expect(bodies.map(body => JSON.parse(body).eventType).sort()).toEqual(["purchase", "registration"]);
    } finally {
      send.mockRestore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("finds a transaction that commits after a sweep with an older timestamp", async () => {
    const late = new Client({ connectionString: testUrl });
    await late.connect();
    try {
      await late.query("BEGIN");
      await late.query('INSERT INTO users VALUES ($1, $2)', ["late_commit", config.from]);
      expect(await outbox.captureMarketingConversions(config)).toBe(0);
      await user("newer_commit");
      expect(await outbox.captureMarketingConversions(config)).toBe(1);
      await late.query("COMMIT");
      expect(await outbox.captureMarketingConversions(config)).toBe(1);
    } finally {
      await late.query("ROLLBACK");
      await late.end();
    }
  });

  it("claims each row once concurrently and fences an expired worker", async () => {
    await user(); await outbox.captureMarketingConversions(config);
    const claims = await Promise.all(Array.from({ length: 6 }, () => outbox.claimMarketingConversion(config)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(row => row !== null)!;
    await prisma.marketingConversion.update({ where: { id: first.id }, data: { leaseUntil: new Date(0) } });
    const successor = (await outbox.claimMarketingConversion(config))!;
    expect(successor.leaseId).not.toBe(first.leaseId);
    expect(await outbox.finishMarketingConversion(first, { kind: "delivered", status: 201, receiptId })).toBe(false);
    expect(await outbox.processMarketingConversion(first, config, fixture().reader, async () => { throw new Error("stale send"); })).toBe("lease_lost");
    expect(await outbox.processMarketingConversion(successor, config, fixture().reader, withIdentity(async () => received()))).toBe("delivered");
  });

  it("persists exact bytes before HTTP, retries an uncertain acceptance and survives key rotation", async () => {
    await ledger("payment", "subscription", "pi_fixture");
    await outbox.captureMarketingConversions(config);
    const first = (await outbox.claimMarketingConversion(config))!;
    let firstBody = "";
    const reader = fixture().reader;
    expect(await outbox.processMarketingConversion(first, config, reader, withIdentity(async (request) => {
      firstBody = await request.text();
      expect((await prisma.marketingConversion.findUniqueOrThrow({ where: { id: first.id } })).payload).toBe(firstBody);
      throw new Error("response lost after receiver commit");
    }))).toBe("retry");
    await due(first.id);
    const retry = (await outbox.claimMarketingConversion(config))!;
    reader.payment = async () => { throw new Error("must not reconstruct accepted payment"); };
    expect(await outbox.processMarketingConversion(retry, { ...config, serverKey: "rotated-test-key" }, reader, withIdentity(async request => {
      expect(await request.text()).toBe(firstBody);
      expect(request.headers.get("authorization")).toBe("Bearer rotated-test-key");
      return received(true);
    }))).toBe("delivered");
    expect(await prisma.marketingConversion.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ receiptId, status: "delivered", attempts: 2, payload: firstBody });
  });

  it("keeps an old original payment as a refund dependency and deduplicates CS/PI aliases", async () => {
    await ledger("refund", "usage", null, "re_fixture");
    await ledger("cs_purchase", "subscription", "cs_fixture");
    await ledger("pi_purchase", "subscription", "pi_fixture");
    await outbox.captureMarketingConversions(config);
    const f = fixture(); f.payment.metadata = {};
    const bodies = new Map<string, string>();
    for (let index = 0; index < 4; index++) {
      const row = (await outbox.claimMarketingConversion(config))!;
      expect(row).not.toBeNull();
      expect(await outbox.processMarketingConversion(row, config, f.reader, withIdentity(async request => {
        const body = await request.text(); const event = JSON.parse(body);
        const previous = bodies.get(event.eventId);
        if (previous) expect(body).toBe(previous);
        bodies.set(event.eventId, body);
        return received(Boolean(previous));
      }))).toBe("delivered");
    }
    expect(bodies.size).toBe(2);
    expect(await prisma.marketingConversion.count({ where: { status: "delivered" } })).toBe(4);
  });

  it("holds a conflicting receipt and retries auth/rate-limit failures without changing identity", async () => {
    await user(); await outbox.captureMarketingConversions(config);
    for (const status of [401, 429, 409]) {
      const row = (await outbox.claimMarketingConversion(config))!;
      const result = await outbox.processMarketingConversion(row, config, fixture().reader, withIdentity(async () => new Response("untrusted receiver detail", { status })));
      expect(result).toBe(status === 409 ? "blocked" : "retry");
      const saved = await prisma.marketingConversion.findUniqueOrThrow({ where: { id: row.id } });
      expect(saved.receiptId).toBeNull();
      expect(saved.payload).toBe(row.payload);
      expect(saved.errorCode).not.toContain("untrusted");
      await due(row.id);
    }
    expect(await outbox.claimMarketingConversion(config)).toBeNull();
  });

  it("separates TEST/LIVE sources and refuses a source identity reused for a different environment", async () => {
    await user(); await outbox.captureMarketingConversions(config);
    const live = { ...config, sourceId: randomUUID(), environment: "live" as const };
    expect(await outbox.claimMarketingConversion(live)).toBeNull();
    expect(await outbox.captureMarketingConversions(live)).toBe(1);
    const row = (await outbox.claimMarketingConversion(config))!;
    await expect(outbox.processMarketingConversion(row, live, fixture().reader)).rejects.toMatchObject({ code: "outbox_source_mismatch" });
    await expect(outbox.captureMarketingConversions({ ...config, environment: "live" })).rejects.toMatchObject({ code: "source_environment_mismatch" });
  });

  it("keeps persisted events pending without POST or acknowledgement when receiver identity is rejected", async () => {
    await user(); await outbox.captureMarketingConversions(config);
    for (const identity of [
      { schemaVersion: 1, sourceId: randomUUID(), environment: "test", keyId: receiptId, capabilities: ["registrations", "purchases", "refunds"] },
      { schemaVersion: 1, sourceId: config.sourceId, environment: "live", keyId: receiptId, capabilities: ["registrations", "purchases", "refunds"] },
      null,
    ]) {
      const row = (await outbox.claimMarketingConversion(config))!;
      const methods: string[] = [];
      expect(await outbox.processMarketingConversion(row, config, fixture().reader, async request => {
        methods.push(request.method);
        return identity ? Response.json(identity) : new Response(null, { status: 401 });
      })).toBe("retry");
      expect(methods).toEqual(["GET"]);
      const saved = await prisma.marketingConversion.findUniqueOrThrow({ where: { id: row.id } });
      expect(saved.status).toBe("pending");
      expect(saved.receiptId).toBeNull();
      expect(saved.deliveredAt).toBeNull();
      expect(saved.payload).toBe(row.payload);
      expect(saved.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      await due(row.id);
    }
  });

  it("enforces immutable request bytes/identity and valid lease/receipt state in PostgreSQL", async () => {
    await user(); await outbox.captureMarketingConversions(config);
    const row = (await prisma.marketingConversion.findFirstOrThrow());
    for (const data of [{ payload: "changed" }, { reference: "other_user" }, { sourceId: randomUUID() }, { leaseId: "half-lease" }, { status: "delivered" }]) {
      await expect(Promise.resolve(prisma.marketingConversion.update({ where: { id: row.id }, data }))).rejects.toThrow();
    }
    expect((await prisma.marketingConversion.findUniqueOrThrow({ where: { id: row.id } })).payload).toBe(row.payload);
  });
});
