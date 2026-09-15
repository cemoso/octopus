import { describe, expect, it } from "bun:test";
import { conversionId, serializeConversion } from "../marketing-conversions";
import { resolveStripeConversion } from "../marketing-stripe";

import { fixture } from "./fixtures/marketing-stripe";

describe("Stripe-backed cash conversion normalization", () => {
  it("reports captured cash instead of plan credit allocation", async () => {
    const f = fixture();
    const result = await resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test");
    expect(result.event).toMatchObject({ eventType: "purchase", amountMinor: "14800", currency: "USD", purchaseKind: "other_sale", customerId: conversionId("organization", "org_fixture") });
    expect(result.event.occurredAt).toBe(new Date(f.charge.created * 1000).toISOString());
    expect(serializeConversion(result.event)).not.toContain("org_fixture");
    expect(serializeConversion(result.event)).not.toContain("pi_fixture");
  });

  it("normalizes Checkout and PaymentIntent aliases into byte-identical events", async () => {
    const f = fixture();
    f.payment.metadata = {};
    const a = await resolveStripeConversion(f.reader, "purchase", f.checkout.id, "org_fixture", "test");
    const b = await resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test");
    expect(serializeConversion(a.event)).toBe(serializeConversion(b.event));
    expect(a.event).toMatchObject({ purchaseKind: "subscription_initial", transactionId: conversionId("payment", f.payment.id) });
  });

  it.each(["credit_purchase", "auto_reload"])("maps %s without changing money", async (type) => {
    const f = fixture(); f.payment.metadata.type = type;
    const result = await resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test");
    expect(result.event).toMatchObject({ amountMinor: "14800", purchaseKind: type === "auto_reload" ? "auto_reload" : "top_up" });
  });

  it("preserves GBP minor units without a currency conversion", async () => {
    const f = fixture(); f.payment.currency = "gbp"; f.charge.currency = "gbp";
    expect((await resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).event).toMatchObject({ currency: "GBP", amountMinor: "14800" });
  });

  it.each(["processing", "requires_action", "requires_payment_method", "canceled"] as const)("does not publish a %s payment", async (status) => {
    const f = fixture(); f.payment.status = status;
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "payment_not_succeeded" });
  });

  it("rejects cross-environment, cross-org and unsupported cash facts", async () => {
    const f = fixture();
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "live")).rejects.toMatchObject({ code: "stripe_environment_mismatch" });
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "other_org", "test")).rejects.toMatchObject({ code: "payment_organization_mismatch" });
    f.payment.currency = "eur"; f.charge.currency = "eur";
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "unsupported_cash_currency" });
  });

  it.each([0, -10, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid captured amount %s", async (amount) => {
    const f = fixture(); f.payment.amount_received = amount; f.charge.amount_captured = amount;
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "invalid_cash_amount" });
  });

  it("does not treat authorization or a mismatched charge as received cash", async () => {
    const f = fixture(); f.charge.captured = false;
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "charge_not_captured" });
    f.charge.captured = true; f.charge.payment_intent = "pi_other";
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "charge_payment_mismatch" });
  });

  it("emits each successful partial refund and retains its real original payment", async () => {
    const f = fixture();
    const a = await resolveStripeConversion(f.reader, "refund", "re_fixture", "org_fixture", "test");
    f.refund.id = "re_second"; f.refund.amount = 2000; f.refund.created++;
    const b = await resolveStripeConversion(f.reader, "refund", "re_second", "org_fixture", "test");
    expect(a.event).toMatchObject({ eventType: "refund", amountMinor: "1000", originalTransactionId: conversionId("payment", f.payment.id) });
    expect(b.event).toMatchObject({ eventType: "refund", amountMinor: "2000", originalTransactionId: conversionId("payment", f.payment.id) });
    expect(a.event.eventId).not.toBe(b.event.eventId);
    expect(a.originalPurchase).toEqual(b.originalPurchase);
    expect(a.originalPurchase?.event.amountMinor).toBe("14800");
  });

  it.each(["pending", "failed", "canceled"])("does not publish a %s refund", async (status) => {
    const f = fixture(); f.refund.status = status;
    await expect(resolveStripeConversion(f.reader, "refund", "re_fixture", "org_fixture", "test")).rejects.toMatchObject({ code: "refund_not_succeeded" });
  });

  it("holds refunds with inconsistent original charge, amount or timestamp", async () => {
    const f = fixture(); f.refund.amount = 20_000;
    await expect(resolveStripeConversion(f.reader, "refund", "re_fixture", "org_fixture", "test")).rejects.toMatchObject({ code: "invalid_refund_amount_or_time" });
    f.refund.amount = 1000; f.refund.created = f.charge.created - 1;
    await expect(resolveStripeConversion(f.reader, "refund", "re_fixture", "org_fixture", "test")).rejects.toMatchObject({ code: "invalid_refund_amount_or_time" });
    f.refund.created = f.charge.created + 1; f.refund.charge = "ch_other";
    await expect(resolveStripeConversion(f.reader, "refund", "re_fixture", "org_fixture", "test")).rejects.toMatchObject({ code: "refund_payment_mismatch" });
  });
});
