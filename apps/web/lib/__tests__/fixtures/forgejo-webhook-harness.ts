import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

mock.module("server-only", () => ({}));
const secret = "fixture-secret";
const integration = { organizationId: "org-a", forgejoHost: "https://forge.example", username: "review-bot", webhookSecret: secret };
let active = true, dismissed = false, draft = false, state = "open", merged = false;
let deliveries = new Set<string>();
let reviews: Record<string, unknown>[] = [];
let reads = 0, mergedWrites = 0;
let admissionPending = false;
const sha = "a".repeat(40);
mock.module("@octopus/db", () => ({ prisma: {
  forgejoIntegration: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "integration-a" ? integration : null },
  repository: {
    findUnique: async ({ where }: { where: { provider_externalId_organizationId: { provider: string; externalId: string; organizationId: string } } }) => {
      const key = where.provider_externalId_organizationId;
      assert.equal(key.provider, "forgejo");
      assert.equal(key.organizationId, "org-a");
      if (key.externalId !== "https://forge.example:42") return null;
      return { id: "repo-a", fullName: "team/repo", isActive: active, autoReview: true, dismissedAt: dismissed ? new Date() : null };
    },
    updateMany: async () => ({ count: 1 }),
  },
  pullRequest: { updateMany: async () => { mergedWrites++; return { count: 1 }; } },
  webhookDelivery: {
    findUnique: async ({ where }: { where: { provider_deliveryId: { deliveryId: string } } }) => deliveries.has(where.provider_deliveryId.deliveryId) ? { id: "seen" } : null,
    upsert: async ({ create }: { create: { deliveryId: string; resolvedOrganizationId: string } }) => { assert.equal(create.resolvedOrganizationId, "org-a"); deliveries.add(create.deliveryId); },
  },
  $transaction: (items: Promise<unknown>[]) => Promise.all(items),
} }));
mock.module("@/lib/forgejo", () => ({ runWithForgejoRepository: async (_id: string, callback: () => Promise<unknown>) => callback(), getPullRequestDetails: async (org: string, name: string, number: number) => {
  assert.equal(org, "org-a"); assert.equal(name, "team/repo"); assert.equal(number, 7); reads++;
  return { number, title: "Authoritative title", author: "author", url: "https://forge.example/team/repo/pulls/7", headSha: sha, baseSha: "b".repeat(40), state, draft, merged };
} }));
mock.module("@/lib/webhook-shared", () => ({ startReviewFlow: async (params: Record<string, unknown>) => {
  if (admissionPending) return { started: false, reason: "already_in_progress", message: "Admission pending" };
  reviews.push(params); return { started: true, pullRequestId: "pr-a" };
} }));
const { POST } = await import("../../../app/api/forgejo/webhook/[integrationId]/route");
const payload = { action: "opened", repository: { id: 42, full_name: "team/repo" }, pull_request: { number: 7, head: { sha } } };
async function deliver(body: unknown = payload, options: { event?: string; signature?: string; integrationId?: string } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = options.signature ?? createHmac("sha256", secret).update(raw).digest("hex");
  return POST(new Request("https://octopus.example/api/forgejo/webhook/integration-a", {
    method: "POST", body: raw, headers: { "x-forgejo-signature": signature, "x-forgejo-event": options.event ?? "pull_request" },
  }), { params: Promise.resolve({ integrationId: options.integrationId ?? "integration-a" }) });
}
assert.equal((await deliver(payload, { signature: "bad" })).status, 401);
assert.equal((await deliver(payload, { signature: "0".repeat(64) })).status, 401);
assert.equal((await deliver(payload, { integrationId: "other-org" })).status, 401);
assert.equal((await deliver("{" )).status, 400);
assert.equal((await deliver("x".repeat(1024 * 1024 + 1))).status, 413);
assert.equal(reviews.length + reads, 0);
await deliver({ ...payload, repository: { id: 43, full_name: "team/repo" } });
await deliver({ ...payload, repository: { id: 42, full_name: "other/repo" } });
active = false; await deliver(); active = true;
dismissed = true; await deliver(); dismissed = false;
assert.equal(reviews.length + reads, 0);
assert.equal((await deliver()).status, 200);
assert.equal(reviews.length, 1);
assert.equal(reviews[0].provider, "forgejo");
assert.equal(reviews[0].orgId, "org-a");
assert.equal(reviews[0].prTitle, "Authoritative title");
await deliver();
assert.equal(reviews.length, 1);
assert.equal(reads, 1);
deliveries = new Set(); reviews = []; draft = true;
await deliver(); assert.equal(reviews.length, 0);
draft = false; deliveries.clear(); state = "closed";
await deliver(); assert.equal(reviews.length, 0);
merged = true;
await deliver({ ...payload, action: "closed" });
assert.equal(mergedWrites, 1);
state = "open"; merged = false;
const comment = { action: "created", repository: payload.repository, issue: { number: 7, pull_request: {} }, comment: { id: 3, body: "/octopus review", user: { login: "review-bot" } } };
await deliver(comment, { event: "issue_comment" }); assert.equal(reviews.length, 0);
comment.comment.user.login = "member";
await deliver(comment, { event: "issue_comment" }); assert.equal(reviews.length, 1);
assert.equal(reviews[0].triggerCommentId, 3);
assert.equal(reviews[0].prAuthor, "author");
console.log("Forgejo webhook checks passed");

deliveries.clear(); reviews = []; admissionPending = true;
assert.equal((await deliver()).status, 503);
assert.equal(deliveries.size, 0, "a pending admission without durable enqueue evidence must stay retryable");
admissionPending = false;
assert.equal((await deliver()).status, 200);
assert.equal(reviews.length, 1);
