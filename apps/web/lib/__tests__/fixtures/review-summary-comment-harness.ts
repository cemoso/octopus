import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));
const head = "a".repeat(40), nextHead = "b".repeat(40);
let current = { headSha: head, reviewRequestVersion: 1, reviewCommentId: null as bigint | null, reviewBody: null as string | null, status: "pending" };
const archived = [{ id: "11111111-2222-4333-8444-555555555555", headSha: head, createdAt: new Date("2026-09-11T12:00:00Z"), reviewBody: "Original immutable report" }];
const before = structuredClone(archived);
let exists = true;
const tx = {
  $queryRaw: async (_sql: TemplateStringsArray, id: string) => { assert.equal(id, "pr"); return exists ? [{ ...current }] : []; },
  reviewAttempt: { findMany: async (query: { where: { pullRequestId: string }; take: number; select: Record<string, boolean> }) => {
    assert.equal(query.where.pullRequestId, "pr");
    assert.equal(query.take, 5);
    assert.equal(query.select.reviewBody, undefined);
    return archived.map(({ id, headSha, createdAt }) => ({ id, headSha, createdAt }));
  } },
  pullRequest: { updateMany: async ({ data }: { data: { reviewCommentId: number } }) => { current.reviewCommentId = BigInt(data.reviewCommentId); return { count: 1 }; } },
};
// The test double models the exclusive row lock: concurrent publications and
// admission serialize. The provider side effects below are the assertions.
let tail = Promise.resolve();
function transaction<T>(run: (client: typeof tx) => Promise<T>): Promise<T> {
  const result = tail.then(async () => {
    const snapshot = { ...current };
    try { return await run(tx); } catch (error) { current = snapshot; throw error; }
  });
  tail = result.then(() => {}, () => {});
  return result;
}
mock.module("@octopus/db", () => ({ prisma: { $transaction: transaction } }));
const calls: { method: string; id: number; body: string }[] = [];
let nextId = 100;
let failure = "";
let createFailure = false;
const remote = new Map<string, number>();
let beforeUpdate: (() => Promise<void>) | undefined;
mock.module("@/lib/github", () => ({
  findPullRequestSummaryComment: async (_owner: string, _repo: string, _number: number, marker: string) => remote.get(marker) ?? null,
  getInstallationToken: async () => "fixture-token",
  createPullRequestComment: async (_installation: number, _owner: string, _repo: string, _number: number, body: string, _token: string, signal: AbortSignal, marker: string) => {
    assert.equal(signal.aborted, false);
    const id = nextId++;
    calls.push({ method: "POST", id, body });
    remote.set(marker, id);
    if (createFailure) throw new Error("Response lost");
    return id;
  },
  updatePullRequestComment: async (_installation: number, _owner: string, _repo: string, id: number, body: string, _token: string, signal: AbortSignal) => {
    assert.equal(signal.aborted, false);
    if (failure) throw new Error(failure);
    await beforeUpdate?.();
    calls.push({ method: "PATCH", id, body });
  },
}));
const { publishReviewSummary } = await import("../../review-summary-comment");
const target = { pullRequestId: "pr", headSha: head, reviewRequestVersion: 1, installationId: 1, owner: "fixture", repo: "repo", prNumber: 1, body: "Queued" };

await Promise.all([publishReviewSummary(target), publishReviewSummary({ ...target, body: "Preparing" })]);
assert.equal(calls.filter(call => call.method === "POST").length, 1);
assert.equal(current.reviewCommentId, 100n);
current = { ...current, headSha: nextHead, reviewRequestVersion: 2, status: "reviewing" };
const newer = { ...target, headSha: nextHead, reviewRequestVersion: 2 };
await publishReviewSummary({ ...newer, body: "Review in progress" });
assert.equal(calls.at(-1)?.id, 100);
assert.ok(calls.at(-1)?.body.includes(`/api/review-attempts/${archived[0].id}`));
assert.ok(calls.at(-1)?.body.includes("Review history"));
assert.deepEqual(archived, before);
const count = calls.length;
assert.equal(await publishReviewSummary(target), null);
assert.equal(await publishReviewSummary({ ...newer, reviewRequestVersion: 1 }), null);
assert.equal(await publishReviewSummary({ ...newer, expectedReviewBody: "Wrong result" }), null);
assert.equal(calls.length, count);

current.status = "completed";
current.reviewBody = "Durable result";
assert.equal(await publishReviewSummary(newer), null); // late progress cannot erase completion
await publishReviewSummary({ ...newer, body: `Final result\n\nLast reviewed commit: ${nextHead}`, expectedReviewBody: "Durable result" });
assert.ok(calls.at(-1)?.body.endsWith(`Last reviewed commit: ${nextHead}`));
assert.equal(calls.at(-1)?.id, 100);
for (const message of ["Failed to update PR comment: 403", "Failed to update PR comment: 503", "Network timeout"]) {
  failure = message;
  await assert.rejects(publishReviewSummary({ ...newer, expectedReviewBody: "Durable result" }), { message });
  assert.equal(nextId, 101);
  assert.equal(current.reviewCommentId, 100n);
}
failure = "Failed to update PR comment: 404";
await publishReviewSummary({ ...newer, expectedReviewBody: "Durable result" });
assert.equal(current.reviewCommentId, 101n);
failure = "";
await publishReviewSummary({ ...newer, expectedReviewBody: "Durable result" });
assert.deepEqual([calls.at(-1)?.method, calls.at(-1)?.id], ["PATCH", 101]);

current.status = "reviewing";
let release!: () => void, started!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const entered = new Promise<void>(resolve => { started = resolve; });
beforeUpdate = async () => { started(); await gate; };
const oldPublication = publishReviewSummary({ ...newer, body: "Old progress" });
await entered;
const admission = transaction(async () => { current.reviewRequestVersion = 3; current.status = "reviewing"; });
const latestPublication = publishReviewSummary({ ...newer, reviewRequestVersion: 3, body: "Newest progress" });
release();
await Promise.all([oldPublication, admission, latestPublication]);
beforeUpdate = undefined;
assert.ok(calls.at(-1)?.body.startsWith("Newest progress"));
const finalCount = calls.length;
assert.equal(await publishReviewSummary(newer), null);
current.reviewCommentId = null;
createFailure = true;
const recoveryTarget = { ...newer, reviewRequestVersion: 3 };
await assert.rejects(publishReviewSummary(recoveryTarget), /Response lost/);
assert.ok(current.reviewCommentId! < 0n);
const posts = calls.filter(call => call.method === "POST").length;
createFailure = false;
await publishReviewSummary(recoveryTarget);
assert.equal(current.reviewCommentId, BigInt(nextId - 1));
assert.equal(calls.filter(call => call.method === "POST").length, posts);
current.reviewCommentId = -42n;
assert.equal(await publishReviewSummary(recoveryTarget), null);
assert.equal(calls.filter(call => call.method === "POST").length, posts);
current.reviewCommentId = BigInt(nextId - 1);
current.status = "completed";
current.reviewBody = "Archived failure";
await publishReviewSummary({ ...recoveryTarget, body: "Archived failure", expectedReviewBody: "Archived failure" });
assert.ok(calls.at(-1)?.body.startsWith("Archived failure"));
exists = false;
assert.equal(await publishReviewSummary({ ...newer, reviewRequestVersion: 3 }), null);
assert.ok(calls.length >= finalCount);
assert.deepEqual(archived, before);
console.log("PASS stable summary, history, stale fencing, concurrency and failure handling");
