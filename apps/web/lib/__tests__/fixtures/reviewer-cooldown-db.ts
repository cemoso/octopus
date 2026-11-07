import { mock } from "bun:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";

const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert.match(url.pathname, /(^|[-_])test($|[-_])/);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
process.env.GITHUB_APP_ID = "123";
process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
mock.module("server-only", () => ({}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} }, PUBBY_ENABLED: false }));
mock.module("@/lib/elasticsearch", () => ({ writeSyncLog: () => {}, deleteSyncLogs: async () => {} }));
mock.module("@/lib/queue", () => ({
  loadQueueConfig: async () => ({ reviewTimeoutSeconds: 900, largeReviewTimeoutSeconds: 1800 }),
  computeStaleReclaimMs: (seconds: number) => seconds * 1000,
  enqueue: async () => "synthetic", enqueueAfter: async () => "synthetic",
}));
let indexCalls = 0;
mock.module("@/lib/indexer", () => ({ indexRepository: async () => { indexCalls++; throw new Error("unexpected tree request"); } }));
const comments: string[] = [];
const checks: Array<{ conclusion?: string; output?: { summary?: string } }> = [];
let beforeCheck: (() => Promise<void>) | undefined;
let checkId = 320;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const requestUrl = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  assert.equal(requestUrl.hostname, "api.github.com", "unexpected external request");
  const method = init?.method ?? "GET";
  if (requestUrl.pathname.endsWith("/access_tokens")) return Response.json({ token: "synthetic-token" });
  if (requestUrl.pathname.endsWith("/check-runs") && method === "POST") {
    await beforeCheck?.();
    return Response.json({ id: ++checkId });
  }
  if (/\/check-runs\/\d+$/.test(requestUrl.pathname) && method === "PATCH") {
    checks.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 321 });
  }
  if (requestUrl.pathname.includes("/comments") && (method === "POST" || method === "PATCH")) {
    comments.push(JSON.parse(String(init?.body)).body);
    return Response.json({ id: 456 });
  }
  if (requestUrl.pathname.includes("/comments") && method === "GET") return Response.json([]);
  throw new Error(`unexpected synthetic GitHub request: ${method} ${requestUrl.pathname}`);
}) as typeof fetch;
const { prisma } = await import("@octopus/db");
const { processReview } = await import("@/lib/reviewer");
const fixture = randomUUID();
const installationId = Number.parseInt(fixture.slice(0, 7), 16) + 1_000_000;
const org = await prisma.organization.create({ data: { name: "Synthetic", slug: `review-tree-${fixture}`, githubInstallationId: installationId } });
try {
  const repo = await prisma.repository.create({ data: {
    organizationId: org.id, name: "fixture", fullName: "synthetic/fixture", externalId: fixture, installationId,
    indexStatus: "failed", indexRetryAfter: new Date(Date.now() + 60_000), indexRetryInstallationId: installationId,
  } });
  const pr = await prisma.pullRequest.create({ data: {
    repositoryId: repo.id, number: 17, title: "Synthetic", url: "https://example.invalid/pull/17", author: "synthetic", headSha: "a".repeat(40),
  } });
  await processReview(pr.id);
  const result = await prisma.pullRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.equal(result.status, "failed");
  assert.equal(indexCalls, 0);
  assert.equal(checks.at(-1)?.conclusion, "failure", "the required check must not remain pending");
  assert.ok(checks.at(-1)?.output?.summary?.includes("re-trigger the review"), "the check must explain that the review will not resume automatically");
  assert.ok(comments.some(body => body.includes("re-trigger this review")), "recovery instructions must explain the next review action");
  const stale = await prisma.pullRequest.create({ data: {
    repositoryId: repo.id, number: 18, title: "Synthetic newer request", url: "https://example.invalid/pull/18", author: "synthetic", headSha: "b".repeat(40),
  } });
  beforeCheck = async () => { await prisma.pullRequest.update({ where: { id: stale.id }, data: { reviewRequestVersion: { increment: 1 }, status: "pending" } }); };
  const priorComments = comments.length;
  await processReview(stale.id);
  const current = await prisma.pullRequest.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(current.status, "pending", "a superseded attempt must not fail the new review");
  assert.equal(current.reviewRequestVersion, stale.reviewRequestVersion + 1);
  assert.equal(comments.length, priorComments, "a superseded attempt must not publish recovery guidance");
  assert.equal(checks.at(-1)?.conclusion, "neutral", "the superseded attempt's check must not remain pending or fail the new review");
  console.log("Synthetic review cooldown finalized its GitHub check and recovery guidance");
} finally {
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.$disconnect();
}
